import path from "node:path";
import { readEnv } from "./env";

export function dataDirectory() {
  return readEnv("ORBIT_DATA_DIR") ?? path.join(process.cwd(), "data");
}
