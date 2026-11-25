export function fixtureProcessOptions(repo) {
  return {
    cwd: `${repo}/.verify/sandbox`,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      DOCKER_HOST: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
      ...(process.env.ORBIT_SANDBOX_OWNER ? { ORBIT_SANDBOX_OWNER: process.env.ORBIT_SANDBOX_OWNER } : {}),
    },
  };
}
