export type LabeledTopic = { memories: string[]; questions: string[] };
export type LabeledSet = { topics: LabeledTopic[]; unrelated: string[] };

export const MAIN: LabeledSet = {
  topics: [
    {
      memories: ["I deploy everything to Fly.io", "The user deploys everything to Fly.io."],
      questions: ["Where do I host things?", "Where do I deploy things?", "Where should I deploy my new app?"],
    },
    {
      memories: ["My favorite language is Go", "User's favorite programming language is Go."],
      questions: ["Which language do I like, Go or Rust?", "What programming language should I use for this tool?", "What's my favorite programming language?"],
    },
    {
      memories: ["I prefer dark mode in every editor", "User prefers dark mode in every editor."],
      questions: ["Which editor theme should I pick?", "Should my editor use a light or dark theme?", "What color scheme do I like?"],
    },
  ],
  unrelated: [
    "What is 2+2?",
    "Tell me a joke and explain it",
    "How do I sort a list in Python?",
    "What's the weather in Paris tomorrow?",
    "Write a haiku about autumn leaves",
    "Who won the 1998 World Cup?",
    "Translate good morning into Spanish",
    "Explain how photosynthesis works",
    "Recommend a good book about history",
    "How many legs does a spider have?",
  ],
};

export const FLY_PAIR = { question: "Where do I host things?", memory: "I deploy everything to Fly.io" };
