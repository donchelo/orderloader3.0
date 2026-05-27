import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { FLEXO_SPECIFIC_PROMPTS } from "../lib/flexo-prompts-generated";
import { pdfToImages, buildVisionContent } from "../lib/pdf-vision";

async function main() {
  const [, , pdfPath, carpeta] = process.argv;
  const prompt = FLEXO_SPECIFIC_PROMPTS[carpeta];
  if (!prompt) { console.error("No prompt for", carpeta); process.exit(1); }
  const buffer = fs.readFileSync(pdfPath);
  const { pages } = await pdfToImages(buffer);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6", max_tokens: 8192, temperature: 0,
    system: prompt,
    messages: [{ role: "user", content: buildVisionContent(pages) }],
  });
  const raw = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  const clean = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
  console.log(clean);
}
main().catch(console.error);
