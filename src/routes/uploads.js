// 图片上传（契约 3.5）。用户 ai-剧本#12 要求网页端能粘贴图片。
// 为什么不用 multipart：前端只要把 File 直接当 body 发就行，不需要额外的表单编码/解析依赖。
// 为什么文件名必须服务端生成：客户端文件名可以带 ../ 或绝对路径，直接用就是路径穿越。
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 本文件在 src/routes/ 下，项目根要往上两级（少一级会落到 src/data/uploads，静默错位）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

/** mime → 扩展名。只认这四种，其余一律拒绝 */
export const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function resolveUploadDir(dir) {
  return path.resolve(dir || process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR);
}

/** {yyyyMMdd}-{8位随机}.{ext}；随机部分用 hex，够短且无碰撞风险 */
export function makeFileName(ext, now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}-${randomBytes(4).toString('hex')}.${ext}`;
}

/**
 * 上传路由。必须挂在 express.json() 之前（或至少让本路由用自己的 raw 解析器），
 * 否则 json 中间件会把二进制 body 吃掉/直接报 JSON 解析失败。
 * @param {string} [uploadDir]
 */
export function createUploadRouter(uploadDir) {
  const dir = resolveUploadDir(uploadDir);
  const r = express.Router();

  // 单独用 raw 解析器：type 覆盖四种图片 mime，limit 与业务上限一致
  const rawImage = express.raw({
    type: Object.keys(MIME_EXT),
    limit: MAX_UPLOAD_BYTES,
  });

  r.post('/uploads', rawImage, (req, res) => {
    // Content-Type 可能带参数（如 image/png; charset=...），只取分号前那段
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_EXT[mime];
    if (!ext) {
      return res.status(400).json({
        error: {
          code: 'UNSUPPORTED_TYPE',
          message: `只支持 ${Object.keys(MIME_EXT).join(' / ')}，收到 "${mime || '(空)'}"`,
        },
      });
    }

    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) {
      return res.status(400).json({ error: { code: 'EMPTY_BODY', message: '请求体为空' } });
    }
    if (buf.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '单张图片上限 10MB' } });
    }

    fs.mkdirSync(dir, { recursive: true }); // 目录不存在就建，别让首次上传失败
    const name = makeFileName(ext);
    fs.writeFileSync(path.join(dir, name), buf);

    res.status(201).json({ url: `/uploads/${name}`, name, size: buf.length, mime });
  });

  return r;
}

/** 413 在 raw 解析器内部抛出时，走不到上面的 handler，这里单独归一 */
export function uploadErrorHandler(err, req, res, next) {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '单张图片上限 10MB' } });
  }
  return next(err);
}
