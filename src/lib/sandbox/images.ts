export const sandboxImages = {
  python: {
    image: "python:3.13-slim@sha256:d0a9e379c0c588befb0e427db17ca9731751d281f32c6cb1a90a1277b680bdad",
    command: ["python3", "-"],
  },
  javascript: {
    image: "node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d",
    command: ["node", "-"],
  },
};
