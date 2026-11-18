import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexResponsesClient } from './codexResponsesClient.js';
import { createCodexCoverCornersClient } from './codexCoverCornersClient.js';

const create = vi.fn();
vi.mock('./codexResponsesClient.js', () => ({
  createCodexResponsesClient: vi.fn(() => ({ create }))
}));

const points = [
  { x: 0.2, y: 0.1 },
  { x: 0.8, y: 0.2 },
  { x: 0.7, y: 0.9 },
  { x: 0.1, y: 0.8 }
];

describe('Codex cover corner detection', () => {
  const baseURL = 'http://127.0.0.1:3001/v1';
  const imageUrl = 'https://store.example/game.jpg';

  beforeEach(() => {
    create.mockReset();
    vi.mocked(createCodexResponsesClient).mockClear();
  });

  it('requests four normalized corners using the selected original image and exact model settings', async () => {
    create.mockResolvedValue({ output_text: JSON.stringify({ corners: points }) });
    const detect = createCodexCoverCornersClient({ baseURL });
    const { signal } = new AbortController();

    await expect(detect(imageUrl, signal)).resolves.toEqual(points);
    expect(createCodexResponsesClient).toHaveBeenCalledWith({ baseURL });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-6.2-sol',
      reasoning: { effort: 'xhigh' },
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: imageUrl, detail: 'high' }]
      }],
      text: {
        format: expect.objectContaining({
          type: 'json_schema',
          strict: true,
          schema: expect.objectContaining({ additionalProperties: false, required: ['corners'] })
        })
      }
    }), { signal });
  });

  it('returns unavailable when the model provides no corners', async () => {
    create.mockResolvedValue({ output_text: '{"corners":null}' });
    const detect = createCodexCoverCornersClient({ baseURL });

    await expect(detect(imageUrl, new AbortController().signal)).resolves.toBeNull();
  });

  it.each([
    ['missing output', ''],
    ['the wrong number of points', JSON.stringify({ corners: points.slice(0, 3) })],
    ['out-of-range coordinates', JSON.stringify({ corners: [{ x: 1.1, y: 0.1 }, ...points.slice(1)] })],
    ['numeric strings', JSON.stringify({ corners: [{ x: '0.2', y: 0.1 }, ...points.slice(1)] })],
    ['duplicate points', JSON.stringify({ corners: [points[0], ...points.slice(0, 3)] })],
    ['intersecting sides', JSON.stringify({ corners: [points[0], points[2], points[1], points[3]] })],
    ['counterclockwise corners', JSON.stringify({ corners: [points[0], points[3], points[2], points[1]] })],
    ['additional response data', JSON.stringify({ corners: points, confidence: 0.9 })]
  ])('rejects %s before coordinates can reach the image warp', async (_label, output_text) => {
    create.mockResolvedValue({ output_text });
    const detect = createCodexCoverCornersClient({ baseURL });

    await expect(detect(imageUrl, new AbortController().signal)).rejects.toThrow('Invalid AI cover corners');
  });
});
