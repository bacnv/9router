import { NextResponse } from "next/server";
import { pingModelByKind, probeVisionCapability } from "./ping";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const modelKind = kind || "llm";
    const result = await pingModelByKind(model, modelKind);
    if (result.ok && modelKind === "llm") Object.assign(result, await probeVisionCapability(model));
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
