import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("pidash_publish", Path(__file__).resolve().parents[1] / "publish.py")
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PublisherTests(unittest.TestCase):
    def test_real_package_version_shape(self):
        data = publisher.package_metadata("package: name='com.sam.pidash' versionCode='3' versionName='2.2'\napplication-debuggable\n")
        self.assertEqual((data["versionName"], data["versionCode"], data["debuggable"]), ("2.2", 3, True))

    def test_wrong_package_and_path_like_version_fail_closed(self):
        for line in ("package: name='other.app' versionCode='3' versionName='2.2'",
                     "package: name='com.sam.pidash' versionCode='3' versionName='../../secret'",
                     "package: name='com.sam.pidash' versionCode='0' versionName='2.2'", "not an APK"):
            with self.subTest(line=line), self.assertRaises(RuntimeError):
                publisher.package_metadata(line)

    def test_single_certificate_digest_required(self):
        cert = "a" * 64
        self.assertEqual(cert, publisher.signer_digest(f"Signer #1 certificate SHA-256 digest: {cert}\n"))
        for output in ("", f"Signer #1 certificate SHA-256 digest: {cert}\nSigner #2 certificate SHA-256 digest: {cert}\n"):
            with self.assertRaises(RuntimeError):
                publisher.signer_digest(output)

    def test_no_test_evidence_cannot_release(self):
        with self.assertRaises(RuntimeError):
            publisher.test_evidence([])

    def test_failing_skipped_and_empty_tests_cannot_release(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / "TEST-fixture.xml"
            for attrs in ('tests="1" failures="1"', 'tests="1" errors="1"', 'tests="1" skipped="1"', 'tests="0"'):
                report.write_text(f"<testsuite {attrs}/>")
                with self.subTest(attrs=attrs), self.assertRaises(RuntimeError):
                    publisher.test_evidence([report])

    def test_successful_evidence_is_aggregated(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = [Path(folder) / str(i) for i in range(2)]
            for path in paths:
                path.write_text('<testsuite tests="2" failures="0" errors="0" skipped="0"/>')
            self.assertEqual(4, publisher.test_evidence(paths)["tests"])

    def test_old_apk_or_test_report_requires_rebuild(self):
        with tempfile.TemporaryDirectory() as folder:
            apk, report, source = [Path(folder) / name for name in ("app.apk", "test.xml", "source.kt")]
            for path in (apk, report, source):
                path.write_text("fixture")
                os.utime(path, ns=(100, 100))
            os.utime(source, ns=(200, 200))
            with self.assertRaises(RuntimeError):
                publisher.fresh_artifacts(apk, [report], [source])
            os.utime(apk, ns=(300, 300))
            with self.assertRaises(RuntimeError):
                publisher.fresh_artifacts(apk, [report], [source])
            os.utime(report, ns=(300, 300))
            publisher.fresh_artifacts(apk, [report], [source])

    def fake_run(self, calls, existing=None, wrong_repo=False, fail_upload=False):
        def run(*args, check=True):
            args = tuple(str(x) for x in args)
            calls.append(args)
            if args[:3] == ("gh", "repo", "view"):
                return subprocess.CompletedProcess(args, 0, json.dumps({"nameWithOwner": "other/repo" if wrong_repo else publisher.REPO}), "")
            if args[:3] == ("git", "remote", "get-url"):
                return subprocess.CompletedProcess(args, 0, f"git@github.com:{publisher.REPO}.git\n", "")
            if args[:3] == ("gh", "release", "view"):
                return subprocess.CompletedProcess(args, 0 if existing else 1, json.dumps(existing) if existing else "", "release not found" if not existing else "")
            if args[:3] == ("git", "rev-parse", "--verify"):
                return subprocess.CompletedProcess(args, 1, "", "")
            if args[:3] == ("gh", "release", "upload") and fail_upload:
                raise RuntimeError("synthetic upload failure")
            return subprocess.CompletedProcess(args, 0, "", "")
        return run

    def test_wrong_origin_never_pushes_or_uploads(self):
        calls = []
        with patch.object(publisher, "run", self.fake_run(calls, wrong_repo=True)), self.assertRaises(RuntimeError):
            publisher.publish(Path("unused"), {"tag": "android-v2.2-build3", "sourceCommit": "fixture"}, Path("unused"))
        self.assertEqual(1, len(calls))

    def test_published_version_is_never_overwritten(self):
        calls = []
        with patch.object(publisher, "run", self.fake_run(calls, existing={"isDraft": False, "url": "fixture", "assets": []})), self.assertRaises(RuntimeError):
            publisher.publish(Path("unused"), {"tag": "android-v2.2-build3", "sourceCommit": "fixture"}, Path("unused"))
        self.assertFalse(any(c[:2] == ("git", "push") or c[:3] == ("gh", "release", "upload") for c in calls))

    def test_draft_is_published_only_after_verified_assets_upload(self):
        calls = []
        with tempfile.TemporaryDirectory() as folder:
            apk = Path(folder) / "fixture.apk"
            apk.write_bytes(b"synthetic APK fixture, not a production build")
            metadata = {"tag": "android-v2.2-build3", "sourceCommit": "fixture", "versionName": "2.2", "versionCode": 3,
                        "debuggable": True, "apkSha256": publisher.file_sha256(apk)}
            with patch.object(publisher, "run", self.fake_run(calls)), patch("builtins.print"):
                publisher.publish(apk, metadata, Path("fixture-notes"))
        uploads = [i for i, c in enumerate(calls) if c[:3] == ("gh", "release", "upload")]
        final = next(i for i, c in enumerate(calls) if c[:3] == ("gh", "release", "edit"))
        self.assertEqual(3, len(uploads))
        self.assertLess(max(uploads), final)
        self.assertTrue(any("--draft" in c and "--verify-tag" in c for c in calls))
        self.assertTrue(any(c[:3] == ("git", "push", "origin") and c[-1] == "refs/tags/android-v2.2-build3" for c in calls))
        self.assertFalse(any("--force" in c or "--clobber" in c for c in calls))

    def test_failed_upload_leaves_draft_not_public_release(self):
        calls = []
        with tempfile.TemporaryDirectory() as folder:
            apk = Path(folder) / "fixture.apk"; apk.write_bytes(b"synthetic")
            metadata = {"tag": "android-v2.2-build3", "sourceCommit": "fixture", "versionName": "2.2", "versionCode": 3,
                        "debuggable": True, "apkSha256": publisher.file_sha256(apk)}
            with patch.object(publisher, "run", self.fake_run(calls, fail_upload=True)), self.assertRaises(RuntimeError):
                publisher.publish(apk, metadata, Path("fixture-notes"))
        self.assertFalse(any(c[:3] == ("gh", "release", "edit") for c in calls))


if __name__ == "__main__":
    unittest.main()
