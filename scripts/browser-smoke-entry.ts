import { complete, getModel } from "@mariozechner/OXI-ai";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);
