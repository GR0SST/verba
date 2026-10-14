/// <reference lib="webworker" />
import { Supertonic, type SynthesisOptions } from "./supertonic"

export type WorkerRequest =
  | { type: "load"; baseUrl: string }
  | { type: "synthesize"; id: number; text: string; options: SynthesisOptions }

export type WorkerResponse =
  | { type: "progress"; label: string; loaded: number; total: number }
  | { type: "ready"; backend: "webgpu" | "wasm"; sampleRate: number }
  | { type: "load-error"; message: string }
  | { type: "audio"; id: number; samples: Float32Array; words?: number[] }
  | { type: "synthesis-error"; id: number; message: string }

declare const self: DedicatedWorkerGlobalScope

let engine: Promise<Supertonic> | undefined
const post = (message: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(message, transfer)
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === "load") {
    engine ??= Supertonic.load(request.baseUrl, (progress) => post({ type: "progress", ...progress }))
    try {
      const tts = await engine
      post({ type: "ready", backend: tts.backend, sampleRate: tts.sampleRate })
    } catch (error) {
      engine = undefined
      post({ type: "load-error", message: describe(error) })
    }
    return
  }

  try {
    if (!engine) throw new Error("Model is not loaded")
    const { samples, words } = await (await engine).synthesize(request.text, request.options)
    post({ type: "audio", id: request.id, samples, words }, [samples.buffer])
  } catch (error) {
    post({ type: "synthesis-error", id: request.id, message: describe(error) })
  }
}
