import type { AiBggMatchDecision, AiBggMatchingClient } from './aiBggMatchingService.js';

const BOMBEROS_REQUEST = {
  itemName: 'Bomberos En Accion | Haba',
  imageUrl: 'https://cdn.shopify.com/s/files/1/0556/0493/6985/files/bomberos-en-accion-haba-152327.jpg?v=1726573771'
};
const EXPECTED_BGG_ID = 296354;

export async function verifyAiBggMatchingCanary(
  client: AiBggMatchingClient,
  model: string
): Promise<AiBggMatchDecision> {
  const decision = await client.findMatch(BOMBEROS_REQUEST, { model });

  if (
    !decision.matchFound ||
    decision.bggId !== EXPECTED_BGG_ID ||
    decision.coverAssessment !== 'MATCH'
  ) {
    throw new Error('AI BGG canary expected BGG ID 296354.');
  }

  return decision;
}
