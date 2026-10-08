import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { SYSTEM_PROMPT_SQL, type Message } from "./app.js";

export const MODEL_ID = "TinyLlama/TinyLlama-1.1B-Chat-v1.0";
export const ADAPTER_ID = "hf://buckets/steephole5586/pwnednext-tinyllama-lora-sql-adapter";
export const MODEL_PATH = "./TinyLlama-1.1B-Chat-v1.0";
export const ADAPTER_PATH = "./pwnednext-tinyllama-lora-sql-adapter";
export const GGUF_MODEL_PATH = process.env.MODEL_GGUF_PATH ?? "./gguf/tinyllama-f16.gguf";
export const GGUF_ADAPTER_PATH = process.env.ADAPTER_GGUF_PATH ?? "./gguf/pwnednext-tinyllama-lora.gguf";

export type ModelEngine = {
  modelPath: string;
  adapterPath: string;
  generate: (messages: Message[]) => Promise<string>;
};

// This is the small receipt describing the model files we found, not the model itself. Details are optional until they are not.
export type ModelArtifacts = {
  modelId: string;
  adapterId: string;
  modelWeightBytes: number;
  adapterWeightBytes: number;
  acceptsInjectedToolCalls: boolean;
};

export function loadModelArtifacts(
  modelPath = process.env.MODEL_PATH ?? MODEL_PATH,
  adapterPath = process.env.ADAPTER_PATH ?? ADAPTER_PATH,
): ModelArtifacts {
  // Read each configuration file to identify the model and the adapter's declared tuning targets.
  const modelConfig = JSON.parse(readFileSync(join(modelPath, "config.json"), "utf8")) as { model_type?: string };
  const adapterConfig = JSON.parse(readFileSync(join(adapterPath, "adapter_config.json"), "utf8")) as { target_modules?: unknown };
  // Keep only a real list; arbitrary configuration values do not deserve to become a list just because we want one.
  const targetModules = Array.isArray(adapterConfig.target_modules) ? adapterConfig.target_modules : [];

  return {
    modelId: `${MODEL_ID}:${modelConfig.model_type ?? "unknown"}`,
    adapterId: ADAPTER_ID,
    modelWeightBytes: statSync(join(modelPath, "model.safetensors")).size,
    adapterWeightBytes: statSync(join(adapterPath, "adapter_model.safetensors")).size,
    acceptsInjectedToolCalls: targetModules.includes("q_proj"),
  };
}

// Let user instructions drive the tool call in fallback mode; the demo needs no expensive GPU.
export function generateFallback(messages: Message[], artifacts?: ModelArtifacts): string {
  // The newest message is either the original question or the database result from the first pass.
  const latest = messages.at(-1)?.content ?? "";
  if (messages[0]?.content === SYSTEM_PROMPT_SQL && !latest.includes("Tool execution result:")) {
    // Copy a tool call hidden in the user's text when the adapter says it supports that neat little trick.
    const injected = latest.match(/\{"tool"\s*:\s*"investigation_fraud"[\s\S]*?\}\}/)?.[0];
    if (injected && artifacts?.acceptsInjectedToolCalls !== false) return injected;
    // Otherwise investigate every row already marked as fraud, which is the only sensible default we bothered to add.
    return '{"tool":"investigation_fraud","args":{"query":"SELECT * FROM investigations WHERE fraud_detected=\'true\'"}}';
  }
  // After the tool has run, echo its serialized rows as the fallback's final answer.
  return `Fallback mode is active. Results: ${latest.match(/Tool execution result:\n([\s\S]*?)\n\nAnswer/)?.[1] ?? "[]"}`;
}

function formatMessages(messages: Message[]): string {
  return `${messages.map((message) => `${message.role}: ${message.content}`).join("\n\n")}\nassistant:`;
}

export async function createNativeModelEngine(
  modelPath = process.env.MODEL_GGUF_PATH ?? GGUF_MODEL_PATH,
  adapterPath = process.env.ADAPTER_GGUF_PATH ?? GGUF_ADAPTER_PATH,
): Promise<ModelEngine> {
  const llama = await getLlama();
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: 0,
  });
  let generationQueue = Promise.resolve();

  const generate = (messages: Message[]): Promise<string> => {
    const generation = generationQueue.then(async () => {
      const context = await model.createContext({
        lora: adapterPath,
      });
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
      });
      try {
        return await session.prompt(formatMessages(messages), {
          maxTokens: 384,
          temperature: 0.2,
        });
      } finally {
        session.dispose();
        await context.dispose();
      }
    });
    generationQueue = generation.then(() => undefined, () => undefined);
    return generation;
  };

  return { modelPath, adapterPath, generate };
}

export function createModelApp(engine: ModelEngine) {
  const app = express();
  app.use(express.json());
  app.post("/generate", (request, response) => {
    // Refuse an empty request before asking the fallback to pretend it has context.
    const messages = request.body?.messages as Message[] | undefined;
    if (!Array.isArray(messages) || !messages.length) return response.status(400).json({ error: "Missing 'messages' field (list of chat messages)" });
    return void engine.generate(messages)
      .then((result) => response.json({ result }))
      .catch((error: unknown) => response.status(500).json({ error: String(error) }));
  });
  // Let deployment checks confirm that the service and its local artifacts are present.
  app.get("/health", (_request, response) => response.json({
    status: "llama.cpp",
    model: engine.modelPath,
    adapter: engine.adapterPath,
  }));
  return app;
}

/* c8 ignore next 3 -- executable listener; importing this module must not bind a test port. */
if (process.argv[1]?.endsWith("model-service.ts")) {
  void createNativeModelEngine()
    .then((engine) => createModelApp(engine).listen(9001, "0.0.0.0", () => console.log("Model service ready on port 9001.")))
    .catch((error: unknown) => {
      console.error("Model service failed to start with real inference enabled.", error);
      process.exitCode = 1;
    });
}