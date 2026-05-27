import { FLEXO_SPECIFIC_PROMPTS } from "../lib/flexo-prompts-generated";
const carpeta = process.argv[2];
const p = FLEXO_SPECIFIC_PROMPTS[carpeta];
if (!p) {
  console.error("No hay prompt para:", carpeta);
  console.log("Disponibles:", Object.keys(FLEXO_SPECIFIC_PROMPTS).join(", "));
  process.exit(1);
}
console.log(p);
