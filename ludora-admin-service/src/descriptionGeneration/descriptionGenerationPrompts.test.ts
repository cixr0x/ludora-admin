import { describe, expect, it } from 'vitest';

import { systemPromptForDescriptionGeneration } from './descriptionGenerationPrompts.js';

describe('description generation prompts', () => {
  it('instructs the model to return plain prose without Markdown formatting', () => {
    const prompt = systemPromptForDescriptionGeneration();

    expect(prompt).toContain('plain Spanish prose');
    expect(prompt).toContain('Do not use Markdown');
    expect(prompt).toContain('asterisks');
    expect(prompt).toContain('bold');
    expect(prompt).toContain('italics');
    expect(prompt).toContain('headings');
    expect(prompt).toContain('lists');
  });
});
