import type { NormalizedCoverPoint } from '../coverFlatteningWorkflow.js';
import { createCodexResponsesClient, type CodexResponsesClientOptions } from './codexResponsesClient.js';

const instructions = [
  'Find the four outer vertices of the front artwork face of the board game box in the attached source image.',
  'These corners will be used to correct the perspective and make a straight-on poster of the entire front artwork.',
  'Use the physical edges of that front face. Exclude the top, spine, other side faces, shadows, and background.',
  'Return the actual vertices clockwise, starting at the front face’s top left, then top right, bottom right, and bottom left.',
  'Measure each coordinate against the full attached image, where x grows right and y grows down.',
  'Use 0 for the left or top image edge and 1 for the right or bottom image edge.',
  'If the image is missing or any of the four vertices cannot be identified confidently, return {"corners":null}.',
  'Use only the attached image. Do not browse for an alternative or invent points for hidden or cropped corners.'
].join(' ');

const coordinate = { type: 'number', minimum: 0, maximum: 1 };
const cornersSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['corners'],
  properties: {
    corners: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y'],
            properties: { x: coordinate, y: coordinate }
          }
        }
      ]
    }
  }
};

export function createCodexCoverCornersClient(options: CodexResponsesClientOptions) {
  const responses = createCodexResponsesClient(options);

  return async (imageUrl: string, signal: AbortSignal): Promise<NormalizedCoverPoint[] | null> => {
    const response = await responses.create({
      model: 'gpt-6.2-sol',
      reasoning: { effort: 'xhigh' },
      instructions,
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: imageUrl, detail: 'high' }]
      }],
      text: { format: { type: 'json_schema', name: 'cover_corners', strict: true, schema: cornersSchema } }
    }, { signal });

    return parseCoverCorners(response.output_text);
  };
}

function parseCoverCorners(output: string): NormalizedCoverPoint[] | null {
  const invalid = new Error('Invalid AI cover corners.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw invalid;
  }

  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'corners')) {
    throw invalid;
  }
  const { corners } = parsed;
  if (corners === null) {
    return null;
  }
  if (!Array.isArray(corners) || corners.length !== 4 || !corners.every(isNormalizedPoint)) {
    throw invalid;
  }
  const clockwiseConvex = corners.every((start, index) => {
    const end = corners[(index + 1) % corners.length]!;
    const next = corners[(index + 2) % corners.length]!;
    return (end.x - start.x) * (next.y - end.y) - (end.y - start.y) * (next.x - end.x) > 0;
  });
  if (!clockwiseConvex) {
    throw invalid;
  }
  return corners;
}

function isNormalizedPoint(point: unknown): point is NormalizedCoverPoint {
  return isRecord(point) && Object.keys(point).length === 2
    && isNormalizedCoordinate(point.x) && isNormalizedCoordinate(point.y);
}

function isNormalizedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
