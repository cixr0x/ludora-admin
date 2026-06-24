import { describe, expect, it } from 'vitest';

import { buildBggRelationshipRepairPlan } from './bggRelationshipRepair.js';

describe('BGG relationship repair', () => {
  it('builds implementation directions from cached BGG inbound semantics', () => {
    const plan = buildBggRelationshipRepairPlan({
      cachedThings: [
        {
          bgg_id: 224517,
          raw_xml: `
            <items>
              <item type="boardgame" id="224517">
                <name type="primary" value="Brass: Birmingham" />
                <link type="boardgameimplementation" id="452264" value="Brass: Pittsburgh" />
                <link type="boardgameimplementation" id="28720" value="Brass: Lancashire" inbound="true"/>
              </item>
            </items>
          `
        }
      ],
      items: [
        { bgg_id: 224517, id: 1, parent_item_id: null },
        { bgg_id: 28720, id: 2, parent_item_id: null },
        { bgg_id: 452264, id: 3, parent_item_id: null }
      ],
      relationships: []
    });

    expect(plan.expectedRelationships.map(relationshipSummary)).toEqual([
      '1 implementation 2',
      '3 implementation 1'
    ]);
  });

  it('repairs extension rows and chooses the most specific cached parent item id', () => {
    const plan = buildBggRelationshipRepairPlan({
      cachedThings: [
        {
          bgg_id: 34691,
          raw_xml: `
            <items>
              <item type="boardgameexpansion" id="34691">
                <name type="primary" value="Catan: Traders &amp; Barbarians – 5-6 Player Expansion" />
                <link type="boardgameexpansion" id="13" value="Catan" inbound="true"/>
                <link type="boardgameexpansion" id="27760" value="Catan: Traders &amp; Barbarians" inbound="true"/>
              </item>
            </items>
          `
        }
      ],
      items: [
        { bgg_id: 34691, id: 10, parent_item_id: null },
        { bgg_id: 13, id: 11, parent_item_id: null },
        { bgg_id: 27760, id: 12, parent_item_id: null }
      ],
      relationships: [{ id: 91, item_a_id: 11, item_b_id: 10, link_type: 'expansion', source: 'BGG', source_ref: '34691' }]
    });

    expect(plan.expectedRelationships.map(relationshipSummary)).toEqual([
      '10 extension 11',
      '10 extension 12'
    ]);
    expect(plan.relationshipIdsToDelete).toEqual([91]);
    expect(plan.parentUpdates).toEqual([{ itemId: 10, parentItemId: 12, previousParentItemId: null }]);
  });

  it('builds expansion directions from cached BGG inbound semantics', () => {
    const plan = buildBggRelationshipRepairPlan({
      cachedThings: [
        {
          bgg_id: 377061,
          raw_xml: `
            <items>
              <item type="boardgame" id="377061">
                <name type="primary" value="Coffee Rush" />
                <link type="boardgameexpansion" id="411435" value="Coffee Rush: Piece of Cake" />
              </item>
            </items>
          `
        },
        {
          bgg_id: 411435,
          raw_xml: `
            <items>
              <item type="boardgameexpansion" id="411435">
                <name type="primary" value="Coffee Rush: Piece of Cake" />
                <link type="boardgameexpansion" id="377061" value="Coffee Rush" inbound="true"/>
              </item>
            </items>
          `
        }
      ],
      items: [
        { bgg_id: 377061, id: 1, parent_item_id: null },
        { bgg_id: 411435, id: 2, parent_item_id: null }
      ],
      relationships: []
    });

    expect(plan.expectedRelationships.map(relationshipSummary)).toEqual(['2 extension 1']);
    expect(plan.parentUpdates).toEqual([{ itemId: 2, parentItemId: 1, previousParentItemId: null }]);
  });

  it('builds expansion directions from outbound cached BGG expansion links', () => {
    const plan = buildBggRelationshipRepairPlan({
      cachedThings: [
        {
          bgg_id: 377061,
          raw_xml: `
            <items>
              <item type="boardgame" id="377061">
                <name type="primary" value="Coffee Rush" />
                <link type="boardgameexpansion" id="411435" value="Coffee Rush: Piece of Cake" />
              </item>
            </items>
          `
        }
      ],
      items: [
        { bgg_id: 377061, id: 1, parent_item_id: null },
        { bgg_id: 411435, id: 2, parent_item_id: null }
      ],
      relationships: []
    });

    expect(plan.expectedRelationships.map(relationshipSummary)).toEqual(['2 extension 1']);
    expect(plan.parentUpdates).toEqual([{ itemId: 2, parentItemId: 1, previousParentItemId: null }]);
  });

  it('prefers inbound expansion links when choosing a parent item id', () => {
    const plan = buildBggRelationshipRepairPlan({
      cachedThings: [
        {
          bgg_id: 411435,
          raw_xml: `
            <items>
              <item type="boardgameexpansion" id="411435">
                <name type="primary" value="Coffee Rush: Piece of Cake" />
                <link type="boardgameexpansion" id="377061" value="Coffee Rush" inbound="true"/>
              </item>
            </items>
          `
        },
        {
          bgg_id: 999999,
          raw_xml: `
            <items>
              <item type="boardgame" id="999999">
                <name type="primary" value="Coffee Rush Collection" />
                <link type="boardgameexpansion" id="411435" value="Coffee Rush: Piece of Cake" />
              </item>
            </items>
          `
        }
      ],
      items: [
        { bgg_id: 377061, id: 1, parent_item_id: null },
        { bgg_id: 411435, id: 2, parent_item_id: null },
        { bgg_id: 999999, id: 3, parent_item_id: null }
      ],
      relationships: []
    });

    expect(plan.expectedRelationships.map(relationshipSummary)).toEqual(['2 extension 1', '2 extension 3']);
    expect(plan.parentUpdates).toEqual([{ itemId: 2, parentItemId: 1, previousParentItemId: null }]);
  });

  it('deletes only BGG-sourced stale relationships and preserves admin rows', () => {
    const plan = buildBggRelationshipRepairPlan({
      cachedThings: [
        {
          bgg_id: 100,
          raw_xml: `
            <items>
              <item type="boardgame" id="100">
                <name type="primary" value="Original" />
                <link type="boardgameimplementation" id="200" value="Retheme" />
              </item>
            </items>
          `
        }
      ],
      items: [
        { bgg_id: 100, id: 1, parent_item_id: null },
        { bgg_id: 200, id: 2, parent_item_id: null },
        { bgg_id: 300, id: 3, parent_item_id: null }
      ],
      relationships: [
        { id: 7, item_a_id: 1, item_b_id: 2, link_type: 'implementation', source: 'BGG', source_ref: '200' },
        { id: 8, item_a_id: 1, item_b_id: 3, link_type: 'implementation', source: 'admin', source_ref: 'manual' }
      ]
    });

    expect(plan.expectedRelationships.map(relationshipSummary)).toEqual(['2 implementation 1']);
    expect(plan.relationshipIdsToDelete).toEqual([7]);
    expect(plan.preservedNonBggRelationshipIds).toEqual([8]);
  });
});

function relationshipSummary(relationship: { itemAId: number; itemBId: number; linkType: string }): string {
  return `${relationship.itemAId} ${relationship.linkType} ${relationship.itemBId}`;
}
