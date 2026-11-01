export type ModelOption = { id: string; reasoning: boolean | null };

export const CUSTOM_OPTION = -1;

export function modelOptionIndex(options: ModelOption[], model: string) {
  return options.findIndex((option) => option.id === model);
}

export function selectedOptionIndex(options: ModelOption[], model: string, customMode: boolean) {
  return customMode ? CUSTOM_OPTION : modelOptionIndex(options, model);
}

export function showsModelInput(options: ModelOption[], model: string, customMode: boolean) {
  return options.length === 0 || selectedOptionIndex(options, model, customMode) === CUSTOM_OPTION;
}
