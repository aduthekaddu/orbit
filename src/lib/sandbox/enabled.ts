export function sandboxEnabled() {
  return process.env.ORBIT_SANDBOX === "on";
}
