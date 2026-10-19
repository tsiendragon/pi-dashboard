/** Authorized one-shot checks on 2026-10-19; each model/mode called once.
 * Scope fingerprints prevent these records from appearing as verified on another resource.
 * Sources: /tmp/pi-meme-matrix-selectable-models-r1/{summary.json,*-review.jpg}
 * and /tmp/pi-flux-extra-r1/summary.json (English prompts; both successful images reviewed).
 * Image-return success and visual acceptance are different: Kontext returned images but failed review.
 * No credentials, signed URLs, resource addresses or raw responses are retained here.
 */
export interface MemeModelCheck {
  status: 'untested' | 'passed' | 'failed'
  resourceFingerprint?: string
  checkedAt?: string
  elapsedSeconds?: number
  httpStatus?: number
  message?: string
}
const dashscope = '9aec66682ec53fe152fed7d74c68946f79e032efc2b304c27bc1b2bb39ac6821'
const azure = 'f3735e747fb0c17fde867767a9c88319e3b70cb25b4de6299503dfeb09ad36d2'
const azureServices = 'f8bc8aa0a12b4198b11ad7fbc8c1f493ac615d8d1edc963fc48c6bd3ce97eba8'
const passed = (resourceFingerprint: string, elapsedSeconds: number): MemeModelCheck => ({
  status: 'passed', resourceFingerprint, checkedAt: '2026-10-19', elapsedSeconds, httpStatus: 200,
})
const failed = (scope: string, seconds: number, httpStatus: number, message: string): MemeModelCheck => ({
  ...passed(scope, seconds), status: 'failed', httpStatus, message,
})
export const memeModelChecks: Record<string, Partial<Record<'t2i' | 'it2i', MemeModelCheck>>> = {
  'dashscope/qwen-image-3.0': { t2i: passed(dashscope, 49.38), it2i: passed(dashscope, 46.05) },
  'dashscope/qwen-image-3.0-pro': { t2i: passed(dashscope, 40.98), it2i: passed(dashscope, 116.72) },
  'dashscope/qwen-image-2.0': { t2i: passed(dashscope, 121.46), it2i: passed(dashscope, 126.75) },
  'dashscope/qwen-image-2.0-pro': { t2i: passed(dashscope, 54.83), it2i: passed(dashscope, 58.1) },
  'dashscope/z-image-turbo': { t2i: passed(dashscope, 53.4) },
  'azure/gpt-image-2.5-sunburst': { t2i: passed(azure, 25.27), it2i: passed(azure, 35.26) },
  'azure/gpt-image-2.5-flare': {
    t2i: failed(azure, 31.69, 404, '当前资源未找到对应部署（404），未重试。'),
    it2i: failed(azure, 24.05, 404, '当前资源未找到对应部署（404），未重试。'),
  },
  'azure/gpt-image-2': { t2i: passed(azure, 39), it2i: passed(azure, 74.75) },
  'azure/gpt-image-1.5': {
    t2i: passed(azure, 89.83),
    it2i: failed(azure, 52.43, 429, '本次请求被限流（429），未重试；不能据此判定模型不支持。'),
  },
  'azure/FLUX.1-Kontext-pro': {
    t2i: failed(azure, 23.93, 200, '返回图片但内容检查未通过：要求橘猫，实际是山水画，暂不推荐。'),
    it2i: failed(azure, 14.99, 200, '返回图片但内容检查未通过：保留了猫，但未按要求加上红帽子，暂不推荐。'),
  },
  'azure/FLUX-1.1-pro': { t2i: passed(azureServices, 4.37) },
  'azure/FLUX.2-pro': { t2i: passed(azureServices, 5.29), it2i: passed(azureServices, 7.58) },
  'azure/MAI-Image-2e': { t2i: passed(azureServices, 16.46) },
}
