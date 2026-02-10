import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import ffmpegStatic from 'ffmpeg-static'

export default defineEventHandler(async (event) => {
  const chunks: Buffer[] = []
  for await (const chunk of event.node.req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const input = Buffer.concat(chunks)

  if (!input || input.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing video payload'
    })
  }

  if (!ffmpegStatic) {
    throw createError({
      statusCode: 500,
      statusMessage: 'ffmpeg binary unavailable'
    })
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'vidmaker-'))
  const inputPath = join(tempDir, 'input.webm')
  const outputPath = join(tempDir, 'output.mp4')

  try {
    await writeFile(inputPath, input)
    await runFfmpeg(ffmpegStatic, inputPath, outputPath)
    const output = await readFile(outputPath)
    setHeader(event, 'content-type', 'video/mp4')
    return output
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

async function runFfmpeg(ffmpegPath: string, inputPath: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      'faststart',
      outputPath
    ]

    const child = spawn(ffmpegPath, args)
    let stderr = ''

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr || `ffmpeg exited with code ${code}`))
    })
  })
}
