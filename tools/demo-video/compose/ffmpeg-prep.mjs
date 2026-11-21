/**
 * FFmpeg 预处理模块：
 * - 将 Playwright 录制的 VP8 变帧率 WebM 转码为定帧率 30fps、GOP=30（每秒 1 关键帧）的 H.264 MP4；
 * - 按 renderPlan 中由 gaps[] 算出的 segments[] 无缝拼接，彻底消除长等待空档与 seek 卡顿；
 * - 全程 -an（剥离音频流，确保成片纯静音）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function runCmd(cmd, args, label) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
  if (res.error) throw new Error(`${label} 启动失败: ${res.error.message}`)
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-12).join('\n')
    throw new Error(`${label} 失败（exit ${res.status}）:\n${tail}`)
  }
  return res.stdout
}

export function probeVideo(filePath) {
  const out = runCmd(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
    `ffprobe ${filePath}`,
  )
  const data = JSON.parse(out)
  const vStream = (data.streams || []).find((s) => s.codec_type === 'video')
  return {
    file: filePath,
    durationSec: Number(data.format?.duration || vStream?.duration || 0),
    width: Number(vStream?.width || 0),
    height: Number(vStream?.height || 0),
    codec: vStream?.codec_name || '',
    pixFmt: vStream?.pix_fmt || '',
    fps: vStream?.r_frame_rate || '',
    nbStreams: Number(data.format?.nb_streams || 0),
    hasAudio: (data.streams || []).some((s) => s.codec_type === 'audio'),
    sizeBytes: Number(data.format?.size || 0),
  }
}

/**
 * 预处理单个镜头片段：按 segments[] 切段并拼接为 CFR 30fps H.264 MP4。
 */
export function preprocessClip({ inputPath, outputPath, segments, fps = 30 }) {
  if (!existsSync(inputPath)) {
    throw new Error(`找不到原始录屏文件: ${inputPath}`)
  }
  mkdirSync(dirname(outputPath), { recursive: true })

  const segs = segments?.length ? segments : [{ rawStartSec: 0, rawEndSec: 10 }]
  let filterComplex
  if (segs.length === 1) {
    const s = segs[0]
    filterComplex = `[0:v]trim=start=${s.rawStartSec}:end=${s.rawEndSec},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[vout]`
  } else {
    const parts = segs.map(
      (s, i) => `[0:v]trim=start=${s.rawStartSec}:end=${s.rawEndSec},setpts=PTS-STARTPTS[v${i}]`,
    )
    const inputs = segs.map((_, i) => `[v${i}]`).join('')
    filterComplex = `${parts.join(';')};${inputs}concat=n=${segs.length}:v=1:a=0,fps=${fps},format=yuv420p[vout]`
  }

  const args = [
    '-y',
    '-i',
    inputPath,
    '-filter_complex',
    filterComplex,
    '-map',
    '[vout]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '14',
    '-g',
    String(fps),
    '-keyint_min',
    String(fps),
    '-sc_threshold',
    '0',
    '-movflags',
    '+faststart',
    outputPath,
  ]

  runCmd('ffmpeg', args, `FFmpeg 预处理 ${outputPath}`)
  return probeVideo(outputPath)
}

/**
 * 批量预处理 renderPlan 中的全部视频片段到 HyperFrames 工程目录。
 */
export function preprocessAllClips({ renderPlan, dateOutputDir, hfProjectDir }) {
  const results = []
  for (const shot of renderPlan.shots) {
    for (const clip of shot.clips) {
      const inputPath = resolve(dateOutputDir, clip.sourceFile)
      const outputPath = resolve(hfProjectDir, clip.outputRelPath)
      const probed = preprocessClip({
        inputPath,
        outputPath,
        segments: clip.segments,
        fps: renderPlan.fps,
      })
      clip.probed = probed
      results.push({
        shotId: shot.shotId,
        slot: clip.slot,
        source: clip.sourceFile,
        output: clip.outputRelPath,
        segmentsCount: clip.segments.length,
        removedSec: clip.removedSec,
        durationSec: probed.durationSec,
        resolution: `${probed.width}x${probed.height}`,
      })
    }
  }
  return results
}
