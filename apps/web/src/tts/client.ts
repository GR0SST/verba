import type { Synthesis, SynthesisOptions } from "./supertonic"
import type { WorkerRequest, WorkerResponse } from "./tts.worker"

export type EngineState =
  | { status: "idle" }
  | { status: "loading"; label: string; loaded: number; total: number }
  | { status: "ready"; backend: "webgpu" | "wasm"; sampleRate: number }
  | { status: "error"; message: string }

const MODEL_BASE_URL = import.meta.env.VITE_SUPERTONIC_BASE_URL || "https://huggingface.co/Supertone/supertonic-3/resolve/main"

let worker: Worker | undefined
let state: EngineState = { status: "idle" }
let readyPromise: Promise<{ sampleRate: number }> | undefined
let nextId = 0
const pending = new Map<number, { resolve: (result: Synthesis) => void; reject: (error: Error) => void }>()
const listeners = new Set<() => void>()

function setState(next: EngineState) {
  state = next
  listeners.forEach((listener) => listener())
}

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    switch (message.type) {
      case "progress":
        setState({ status: "loading", label: message.label, loaded: message.loaded, total: message.total })
        break
      case "ready":
        setState({ status: "ready", backend: message.backend, sampleRate: message.sampleRate })
        break
      case "load-error":
        readyPromise = undefined
        setState({ status: "error", message: message.message })
        break
      case "audio":
        pending.get(message.id)?.resolve({ samples: message.samples, words: message.words })
        pending.delete(message.id)
        break
      case "synthesis-error":
        pending.get(message.id)?.reject(new Error(message.message))
        pending.delete(message.id)
        break
    }
  }
  return worker
}

export const ttsEngine = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  load() {
    readyPromise ??= new Promise((resolve, reject) => {
      const unsubscribe = ttsEngine.subscribe(() => {
        if (state.status === "ready") {
          unsubscribe()
          resolve({ sampleRate: state.sampleRate })
        } else if (state.status === "error") {
          unsubscribe()
          reject(new Error(state.message))
        }
      })
      setState({ status: "loading", label: "Preparing Supertonic", loaded: 0, total: 1 })
      getWorker().postMessage({ type: "load", baseUrl: MODEL_BASE_URL } satisfies WorkerRequest)
    })
    return readyPromise
  },
  synthesize(text: string, options: SynthesisOptions) {
    const id = nextId++
    return new Promise<Synthesis>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      getWorker().postMessage({ type: "synthesize", id, text, options } satisfies WorkerRequest)
    })
  },
}
