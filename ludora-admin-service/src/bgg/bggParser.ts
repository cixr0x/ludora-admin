import { XMLParser } from 'fast-xml-parser';
import * as HtmlEntities from '@nodable/entities';

export type BggSearchItem = {
  bggId: number;
  name: string;
  type: string;
  yearPublished: number | null;
};

export type BggNamedLink = {
  bggId: number;
  name: string;
};

export type BggRelatedLink = BggNamedLink & {
  inbound: boolean;
};

export type BggThingDetails = {
  alternateNames: string[];
  artists: BggNamedLink[];
  bggId: number;
  categories: BggNamedLink[];
  description: string;
  designers: BggNamedLink[];
  families: BggNamedLink[];
  image: string;
  maxPlayers: number | null;
  maxPlaytime: number | null;
  mechanics: BggNamedLink[];
  minAge: number | null;
  minPlayers: number | null;
  minPlaytime: number | null;
  name: string;
  parentLinks: BggRelatedLink[];
  playingTime: number | null;
  publishers: BggNamedLink[];
  rating: number | null;
  thumbnail: string;
  type: string;
  implementationLinks: BggRelatedLink[];
  weight: number | null;
  yearPublished: number | null;
};

const parser = new XMLParser({
  attributeNamePrefix: '',
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true
});
type EntityDecoderConstructor = new (options: {
  namedEntities: Record<string, string>;
}) => {
  decode(value: string): string;
};
// Package typings expose EntityDecoder as default, while runtime exports it by name.
const { ALL_ENTITIES, EntityDecoder } = HtmlEntities as unknown as {
  ALL_ENTITIES: Record<string, string>;
  EntityDecoder: EntityDecoderConstructor;
};
const htmlEntityDecoder = new EntityDecoder({ namedEntities: ALL_ENTITIES });

export function parseBggSearchResponse(xml: string): BggSearchItem[] {
  const parsed = parser.parse(xml) as BggXmlRoot;
  return asArray(parsed.items?.item).map((item) => ({
    bggId: numberValue(item.id) ?? 0,
    name: primaryName(item),
    type: stringValue(item.type),
    yearPublished: numberValue(item.yearpublished?.value)
  }));
}

export function parseBggThingResponse(xml: string): BggThingDetails | null {
  const parsed = parser.parse(xml) as BggXmlRoot;
  const item = asArray(parsed.items?.item)[0];
  if (!item) {
    return null;
  }

  return {
    alternateNames: namesByType(item, 'alternate'),
    artists: linksByType(item, 'boardgameartist'),
    bggId: numberValue(item.id) ?? 0,
    categories: linksByType(item, 'boardgamecategory'),
    description: stringValue(item.description),
    designers: linksByType(item, 'boardgamedesigner'),
    families: linksByType(item, 'boardgamefamily'),
    image: stringValue(item.image),
    maxPlayers: numberValue(item.maxplayers?.value),
    maxPlaytime: numberValue(item.maxplaytime?.value),
    mechanics: linksByType(item, 'boardgamemechanic'),
    minAge: numberValue(item.minage?.value),
    minPlayers: numberValue(item.minplayers?.value),
    minPlaytime: numberValue(item.minplaytime?.value),
    name: primaryName(item),
    parentLinks: relatedLinksByType(item, 'boardgameexpansion').filter((link) => link.inbound),
    playingTime: numberValue(item.playingtime?.value),
    publishers: linksByType(item, 'boardgamepublisher'),
    rating: numberValue(item.statistics?.ratings?.average?.value),
    thumbnail: stringValue(item.thumbnail),
    type: stringValue(item.type),
    implementationLinks: relatedLinksByType(item, 'boardgameimplementation'),
    weight: numberValue(item.statistics?.ratings?.averageweight?.value),
    yearPublished: numberValue(item.yearpublished?.value)
  };
}

function primaryName(item: BggXmlItem): string {
  const primary = asArray(item.name).find((name) => name.type === 'primary');
  return nameValue(primary?.value);
}

function namesByType(item: BggXmlItem, type: string): string[] {
  return asArray(item.name)
    .filter((name) => name.type === type)
    .map((name) => nameValue(name.value))
    .filter(Boolean);
}

function linksByType(item: BggXmlItem, type: string): BggNamedLink[] {
  return asArray(item.link)
    .filter((link) => link.type === type)
    .map((link) => ({
      bggId: numberValue(link.id) ?? 0,
      name: nameValue(link.value)
    }))
    .filter((link) => link.bggId > 0 && link.name);
}

function relatedLinksByType(item: BggXmlItem, type: string): BggRelatedLink[] {
  return asArray(item.link)
    .filter((link) => link.type === type)
    .map((link) => ({
      bggId: numberValue(link.id) ?? 0,
      inbound: stringValue(link.inbound).toLowerCase() === 'true',
      name: nameValue(link.value)
    }))
    .filter((link) => link.bggId > 0 && link.name);
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function nameValue(value: unknown): string {
  return decodeHtmlEntities(stringValue(value));
}

function decodeHtmlEntities(value: string): string {
  let decoded = value;
  for (let index = 0; index < 3; index += 1) {
    const nextDecoded = htmlEntityDecoder.decode(decoded);
    if (nextDecoded === decoded) {
      return decoded;
    }
    decoded = nextDecoded;
  }
  return decoded;
}

type BggXmlRoot = {
  items?: {
    item?: BggXmlItem | BggXmlItem[];
  };
};

type BggXmlItem = {
  description?: string;
  id?: string;
  image?: string;
  link?: BggXmlLink | BggXmlLink[];
  maxplayers?: BggXmlValue;
  maxplaytime?: BggXmlValue;
  minage?: BggXmlValue;
  minplayers?: BggXmlValue;
  minplaytime?: BggXmlValue;
  name?: BggXmlName | BggXmlName[];
  playingtime?: BggXmlValue;
  statistics?: {
    ratings?: {
      average?: BggXmlValue;
      averageweight?: BggXmlValue;
    };
  };
  thumbnail?: string;
  type?: string;
  yearpublished?: BggXmlValue;
};

type BggXmlName = {
  type?: string;
  value?: string;
};

type BggXmlLink = {
  id?: string;
  inbound?: string;
  type?: string;
  value?: string;
};

type BggXmlValue = {
  value?: string;
};
