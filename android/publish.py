#!/usr/bin/env python3
"""Publish an already-built, verified PiDash APK. Dry-run unless --publish is explicit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
REPO = "tsiendragon/pi-dashboard"
SOURCE_PATHS = ("android/app", "android/gradle", "android/gradlew", "android/gradlew.bat",
                "android/build.gradle.kts", "android/settings.gradle.kts", "android/gradle.properties")


def run(*args, check=True):
    try:
        result = subprocess.run([str(a) for a in args], cwd=ROOT, text=True, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{Path(str(args[0])).name} 步骤超时；请核对远端状态，不盲目重试") from None
    if check and result.returncode:
        # Do not echo command arguments, subprocess environments or potentially credential-bearing URLs.
        raise RuntimeError(f"{Path(str(args[0])).name} 执行失败；未继续发布，请在本机检查该步骤")
    return result


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def package_metadata(badging):
    match = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging, re.M)
    if not match or match[1] != "com.sam.pidash" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", match[3]):
        raise RuntimeError("APK 包名或版本元数据无效")
    code = int(match[2])
    if code < 1:
        raise RuntimeError("versionCode 必须大于零")
    return {"applicationId": match[1], "versionCode": code, "versionName": match[3],
            "debuggable": bool(re.search(r"^application-debuggable\s*$", badging, re.M))}


def signer_digest(output):
    digests = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$", output, re.M)
    if len(digests) != 1:
        raise RuntimeError("需要单一、可核验的 APK 签名")
    return digests[0].lower()


def test_evidence(paths):
    suites = [ET.parse(path).getroot() for path in paths]
    totals = {key: sum(int(suite.get(key, "0")) for suite in suites)
              for key in ("tests", "failures", "errors", "skipped")}
    if not suites or totals["tests"] < 1 or any(totals[key] for key in ("failures", "errors", "skipped")):
        raise RuntimeError("需要成功、无跳过的 Android JUnit 测试结果；先运行测试和构建")
    return totals


def fresh_artifacts(apk, reports, sources):
    latest_source = max((path.stat().st_mtime_ns for path in sources), default=0)
    if apk.stat().st_mtime_ns < latest_source or any(path.stat().st_mtime_ns < latest_source for path in reports):
        raise RuntimeError("APK/测试结果早于当前源码；请先重新测试和构建")


def inspect_apk(apk, sdk):
    tools = [p for p in (sdk / "build-tools").glob("*")
             if re.fullmatch(r"\d+\.\d+\.\d+", p.name) and (p / "aapt").is_file() and (p / "apksigner").is_file()]
    if not tools:
        raise RuntimeError("ANDROID_HOME 中未找到稳定版 aapt/apksigner")
    tool_dir = max(tools, key=lambda p: tuple(map(int, p.name.split("."))))
    metadata = package_metadata(run(tool_dir / "aapt", "dump", "badging", apk).stdout)
    digest = signer_digest(run(tool_dir / "apksigner", "verify", "--print-certs", apk).stdout)
    expected = (ANDROID / "release-signing-cert.sha256").read_text().strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected) or digest != expected:
        raise RuntimeError("签名不匹配，拒绝发布不能覆盖安装的 APK；不得自动换签名或上传私钥")
    with zipfile.ZipFile(apk) as archive:
        if any(name.lower().endswith((".keystore", ".jks", "/.env", "/peer_configs.json")) for name in archive.namelist()):
            raise RuntimeError("APK 含不应打包的私钥或配置文件名，拒绝发布")
    return metadata | {"signerCertificateSha256": digest}


def prepare(apk):
    if run("git", "status", "--porcelain", "--untracked-files=all", "--", *SOURCE_PATHS).stdout.strip():
        raise RuntimeError("Android 构建源码有未提交改动，请先仅提交本版本文件")
    sdk_text = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk_text:
        raise RuntimeError("请设置 ANDROID_HOME")
    if os.environ.get("JAVA_HOME"):
        os.environ["PATH"] = str(Path(os.environ["JAVA_HOME"]) / "bin") + os.pathsep + os.environ.get("PATH", "")
    if not shutil.which("java"):
        raise RuntimeError("请设置 JDK 17 的 JAVA_HOME/PATH")
    metadata = inspect_apk(apk, Path(sdk_text))
    gradle = (ANDROID / "app/build.gradle.kts").read_text()
    code = re.search(r"\bversionCode\s*=\s*(\d+)", gradle)
    name = re.search(r'\bversionName\s*=\s*"([^\"]+)"', gradle)
    if not code or not name or int(code[1]) != metadata["versionCode"] or name[1] != metadata["versionName"]:
        raise RuntimeError("APK 与当前 Gradle 版本不一致，拒绝发布旧包")
    # 3.1 起正文由原生渲染，APK 不再携带离线渲染页；此处只确认 assets 目录未被误加回来。
    stale_assets = ANDROID / "app/src/main/assets/native-renderer"
    if stale_assets.exists():
        raise RuntimeError("APK 不应再包含 native-renderer assets；请删除后重新构建")
    reports = sorted((ANDROID / "app/build/test-results/testDebugUnitTest").glob("TEST-*.xml"))
    metadata["unitTests"] = test_evidence(reports)
    sources = [ROOT / path for path in run("git", "ls-files", "--", *SOURCE_PATHS).stdout.splitlines()]
    fresh_artifacts(apk, reports, sources)
    tag = f"android-v{metadata['versionName']}-build{metadata['versionCode']}"
    notes = ANDROID / "releases" / f"{tag}.md"
    if not notes.is_file():
        raise RuntimeError(f"请先编写 android/releases/{tag}.md 更新说明")
    metadata.update({"tag": tag, "sourceCommit": run("git", "rev-parse", "HEAD").stdout.strip(),
                     "androidSourceCommit": run("git", "log", "-1", "--format=%H", "--", *SOURCE_PATHS).stdout.strip(),
                     "apkSha256": file_sha256(apk),
                     "phoneEndToEndVerified": False})
    return metadata, notes


def publish(apk, metadata, notes):
    # Check the repository inferred from origin before pushing any refs or uploading any asset.
    actual_repo = json.loads(run("gh", "repo", "view", "--json", "nameWithOwner").stdout)["nameWithOwner"]
    origin = run("git", "remote", "get-url", "origin").stdout.strip() if actual_repo == REPO else ""
    allowed = {f"git@github.com:{REPO}{ending}" for ending in ("", ".git")} | {
        f"{prefix}{REPO}{ending}" for prefix in ("https://github.com/", "ssh://git@github.com/") for ending in ("", ".git")}
    if actual_repo != REPO or origin not in allowed:
        raise RuntimeError("origin 不是预期仓库，拒绝推送/发布")
    tag, sha = metadata["tag"], metadata["sourceCommit"]
    existing = run("gh", "release", "view", tag, "--repo", REPO, "--json", "isDraft,url,assets", check=False)
    if existing.returncode == 0:
        if not json.loads(existing.stdout)["isDraft"]:
            raise RuntimeError("此版本已发布，不覆盖公开 APK；新版本必须递增版本号/build")
    elif not re.search(r"release not found|HTTP 404", existing.stderr, re.I):
        raise RuntimeError("无法确认 Release 状态，停止而不是盲目创建")
    local_tag = run("git", "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}", check=False)
    if local_tag.returncode == 0:
        if local_tag.stdout.strip() != sha:
            raise RuntimeError("版本 tag 已指向其他提交，拒绝改写")
    else:
        run("git", "tag", tag, sha)
    run("git", "push", "origin", f"refs/tags/{tag}")  # No branch pushes, force pushes or deletions.
    if existing.returncode:
        run("gh", "release", "create", tag, "--repo", REPO, "--verify-tag", "--draft", "--prerelease",
            "--title", f"PiDash Android {metadata['versionName']} (build {metadata['versionCode']})",
            "--notes-file", notes)
    with tempfile.TemporaryDirectory(prefix="pidash-release-") as folder:
        directory = Path(folder)
        suffix = "debug" if metadata["debuggable"] else "release"
        filename = f"pidash-{metadata['versionName']}-build{metadata['versionCode']}-{suffix}.apk"
        asset = directory / filename
        shutil.copyfile(apk, asset)
        if file_sha256(asset) != metadata["apkSha256"]:
            raise RuntimeError("上传前 APK 已变化，停止发布")
        checksum = directory / "SHA256SUMS"
        checksum.write_text(f"{metadata['apkSha256']}  {filename}\n")
        info = directory / "build-info.json"
        info.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
        names = {item["name"] for item in json.loads(existing.stdout).get("assets", [])} if existing.returncode == 0 else set()
        for path in (asset, checksum, info):
            if path.name in names:
                previous = directory / "previous"
                previous.mkdir(exist_ok=True)
                run("gh", "release", "download", tag, "--repo", REPO, "--pattern", path.name, "--dir", previous)
                if file_sha256(previous / path.name) != file_sha256(path):
                    raise RuntimeError("草稿已有不同附件，拒绝覆盖；请先核对版本与来源")
            else:
                run("gh", "release", "upload", tag, path, "--repo", REPO)
    run("gh", "release", "edit", tag, "--repo", REPO, "--draft=false", "--prerelease")
    print(f"https://github.com/{REPO}/releases/tag/{tag}")
    print(f"https://github.com/{REPO}/releases/download/{tag}/{filename}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, default=ANDROID / "app/build/outputs/apk/debug/app-debug.apk")
    parser.add_argument("--publish", action="store_true", help="明确推送版本 tag 并发布预发布版；默认仅本地校验")
    args = parser.parse_args()
    try:
        apk = args.apk.resolve()
        metadata, notes = prepare(apk)
        print(json.dumps({"mode": "publish" if args.publish else "dry-run", **metadata}, ensure_ascii=False, indent=2))
        if args.publish:
            if run("git", "status", "--porcelain", "--", "android/publish.py", "android/release-signing-cert.sha256", notes.relative_to(ROOT)).stdout.strip():
                raise RuntimeError("发布脚本/证书指纹/更新说明尚未提交，拒绝发布无法溯源的版本")
            publish(apk, metadata, notes)
    except (OSError, ValueError, RuntimeError, ET.ParseError, zipfile.BadZipFile) as error:
        parser.exit(1, f"发布中止：{error}\n")


if __name__ == "__main__":
    main()
