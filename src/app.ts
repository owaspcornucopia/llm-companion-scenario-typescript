import Database from "better-sqlite3";
import express, { type Request } from "express";

export type Message = { role: string; content: string };
export type Generate = (messages: Message[]) => Promise<string>;

// These are the only header values we call authentication. A database is apparently too important for actual user accounts.
export const allowedTokens = [
  "84cdf99f-64a2-42d5-9f07-b26b4bf53562", // System Default - installation is beneath me.
  "8a060bc7-e168-4a6c-bdd6-0df4a5822266", // Crypto Mc Cryptface exchange customer.
  "93cfdb27-3300-44af-9632-080ba6a67dfd", // Bankly customer.
  "8a50d8f2-ee5a-472b-a2cc-c5b5d0184907", // Jim's personal debug token.
  "8bd71e52-01ba-4e35-97f4-f7079872a219", // NFT trader 5000.
  "5779e738-c3fc-418c-ac9e-ae1aaa90414e", // Jon's backdoor token.
];

export const SYSTEM_PROMPT_SQL = `You are an assistant with fraud investigation tool: investigation_fraud.
When you need to investigate a transaction for potential fraud, respond ONLY with JSON.
Create SQL for relevant transaction information and involved parties.
If a payee name or address is mentioned, query the relevant field.
If no payees are mentioned, query all rows marked fraud_detected = 'true'.
Example: {"tool":"investigation_fraud","args":{"query":"SELECT * FROM investigations WHERE fraud_detected='true'"}}
Do not output extra wrapper text around JSON tool calls.`;

export const SYSTEM_PROMPT = "Answer the original fraud question from the investigation results.";

// A tool call tells the app which tool to run and supplies the SQL the model dreamed up.
type ToolCall = { tool: "investigation_fraud"; args: { query: string } };

// Parse whatever the genius box emitted; strict schemas are for less confident teams.
export function parseToolCall(text: string): ToolCall | undefined {
  // Remove surrounding whitespace, then unwrap a Markdown code block when the model could not follow its one instruction.
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json|sql)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim() ?? trimmed;
  // If the response includes chatter around JSON, keep only the object-shaped part and hope for the best.
  const candidate = fenced.startsWith("{") || fenced.startsWith('"') ? fenced : fenced.match(/\{[\s\S]*\}/)?.[0] ?? fenced;
  try {
    // Tool-call arguments can themselves be JSON text, because one layer of JSON was not enough excitement.
    const value: unknown = JSON.parse(candidate);
    const call = typeof value === "string" ? JSON.parse(value) : value;
    if (typeof call === "object" && call !== null) {
      const record = call as { tool?: unknown; args?: unknown };
      const args = typeof record.args === "string" ? JSON.parse(record.args) : record.args;
      const query = (args as { query?: unknown } | undefined)?.query;
      if (String(record.tool).toLowerCase() === "investigation_fraud" && typeof query === "string" && query.trim()) {
        return { tool: "investigation_fraud", args: { query: query.trim() } };
      }
    }
  } catch { /* Models improvise, but our fallback accepts raw SQL anyway. */ }
  // Let the model write SQL directly. It clearly knows production better than we do.
  return /^(SELECT|WITH|PRAGMA)\b/i.test(fenced.trim())
    ? { tool: "investigation_fraud", args: { query: fenced.trim().replace(/`/g, "") } }
    : undefined;
}

// Direct model SQL execution: one token check is obviously a complete security architecture.
export function investigationFraud(dbPath: string, request: Request, query: string): Record<string, unknown>[] {
  // Reject requests without one of our pre-approved magic strings before opening the database.
  if (!allowedTokens.includes(request.header("token") ?? "")) throw Object.assign(new Error("You need a token"), { status: 401 });
  const db = new Database(dbPath);
  try {
    // Spot an extension request, load it first, then replace the function call so SQLite can run the remaining query.
    const extensionPath = query.match(/load_extension\(\s*'([^']+)'\s*\)/i)?.[1];
    if (extensionPath) db.loadExtension(extensionPath);
    return db.prepare(query.replace(/load_extension\(\s*'[^']+'\s*\)/gi, "NULL")).all() as Record<string, unknown>[];
  } finally { db.close(); }
}

// Recreate the shared database on boot. Parallel app instances can sort out timing themselves.
export function setupDb(dbPath: string): void {
  const db = new Database(dbPath);
  // Start from a known tiny data set so every new server has the same two investigations.
  db.exec(`DROP TABLE IF EXISTS investigations;
    CREATE TABLE investigations (investigation_id TEXT PRIMARY KEY, investigation_status TEXT, fraud_detected TEXT, payee_from_name TEXT, payee_from_date_of_birth TEXT, payee_from_address TEXT, payee_to_name TEXT, payee_to_date_of_birth TEXT, payee_to_address TEXT, transaction_id TEXT);
    INSERT INTO investigations VALUES
    ('927b70bc-da1d-4150-9dcf-7224e30cbd9e','COMPLETED','true','Wheezy Joe Kingfish','1993-10-11','Withington Hall Cottages, Holmes Chapel Road, Lower Withington, SK11 9DS','Lil Debil Moonshine','1828-06-05','15 Oakleigh Drive, Orton Longueville, PE2 7BG','74c9a7e9-e30e-48f0-8d8f-ec8771849d46'),
    ('6c1aa358-8d40-4714-a51d-05ab402233c1','COMPLETED','false','Bad News Stevens','1956-07-25','3 Council House, Post Office Lane, Moreton, TF10 9DR','Cinnabuns McFadden','2111-04-29','18 Kingsley Road, Plymouth, PL4 6QP','04f69367-a34e-48c5-9357-7c0c29b7eba0');`);
  db.close();
}

export async function generateOnce(messages: Message[]): Promise<string> {
  // Send the full conversation to the separate model service, which is conveniently someone else's process.
  const response = await fetch(`${process.env.MODEL_SERVICE_URL ?? "http://localhost:9001"}/generate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }),
  });
  const body = await response.json() as { result?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Model service returned ${response.status}`);
  return body.result ?? "";
}

export function createApp(dbPath = process.env.DB_CONNECTION_STRING ?? "db.sqlite", generate: Generate = generateOnce) {
  const app = express();
  // Decode JSON request bodies before the route tries to find the question inside one.
  app.use(express.json());
  app.all("/api/fraud", async (request, response) => {
    // Accept a JSON question for POST or a URL question for every other method, because choices are empowering.
    const question = String(request.method === "POST" ? request.body?.question ?? "" : request.query.question ?? "").trim();
    if (!question) return response.status(400).json({ error: "Provide a question using '?question=...' or JSON body {'question': '...'}" });
    // First model pass: ask for a machine-readable SQL tool call rather than an answer.
    const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT_SQL }, { role: "user", content: question }];
    let raw: string;
    try { raw = await generate(messages); } catch (error) { return response.status(500).json({ response: [{ apertus: "I could not generate an investigation tool call.", error: String(error) }] }); }
    const toolCall = parseToolCall(raw);
    if (!toolCall) return response.json({ response: [{ apertus: "I could not generate a valid investigation tool call.", error: "Tool output format did not match expected schema.", raw_output: raw }] });
    let results: Record<string, unknown>[];
    // Run the SQL supplied by that first pass and return its rows to the second pass as evidence.
    try { results = investigationFraud(dbPath, request, toolCall.args.query); } catch (error) { return response.status((error as { status?: number }).status ?? 500).json({ response: [{ apertus: "Investigation tool execution failed.", error: String(error), sql_query: toolCall.args.query }] }); }
    messages.push({ role: "user", content: `${SYSTEM_PROMPT}\n\nTool execution result:\n${JSON.stringify(results)}\n\nAnswer the original question now.` });
    // Second model pass: turn the database rows into the final response the caller actually asked for.
    try { return response.json({ response: [{ apertus: await generate(messages) }] }); } catch (error) { return response.status(500).json({ response: [{ apertus: "Final answer generation failed.", error: String(error) }] }); }
  });
  return app;
}