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

export const HOLDOUT: LabeledSet = {
  topics: [
    { memories: ["I live in Berlin"], questions: ["What city am I based in?", "Where should I look for an apartment?"] },
    { memories: ["I am allergic to peanuts"], questions: ["Can I eat this satay sauce?", "Which foods should I avoid?"] },
    { memories: ["My dog is called Biscuit"], questions: ["What is my pet's name?", "Suggest a birthday gift for my dog"] },
    { memories: ["I work as a nurse"], questions: ["What is my job?", "Give me tips for a long hospital shift"] },
    { memories: ["I run every morning before work"], questions: ["What exercise do I do?", "Plan my weekly training"] },
  ],
  unrelated: [
    "What is the capital of Australia?",
    "Explain how a transistor works",
    "Summarize the plot of Hamlet",
    "Convert 50 miles to kilometers",
    "What is the derivative of x squared?",
    "Who painted the Mona Lisa?",
    "How does compound interest work?",
    "Write a limerick about the moon",
    "What causes the tides?",
    "List the planets in the solar system",
  ],
};

export const FLY_PAIR = { question: "Where do I host things?", memory: "I deploy everything to Fly.io" };
