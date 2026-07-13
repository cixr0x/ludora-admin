import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type StoreProfile = {
  canonical_domain: string;
  city: string;
  country: string;
  facebook_url: string;
  instagram_url: string;
  logo_url: string;
  name: string;
  platform: string;
  state: string;
  website_url: string;
};

export type StoreProfileAiRequest = {
  headers: Record<string, string>;
  meta: Record<string, string>;
  platformSignals: string[];
  textExcerpt: string;
  websiteUrl: string;
};

export type StoreProfileAiResult = {
  city: string;
  country: string;
  facebookUrl: string;
  instagramUrl: string;
  logoUrl: string;
  metadata: Record<string, unknown>;
  name: string;
  platform: string;
  state: string;
};

export type StoreProfileAiClient = {
  detect(
    request: StoreProfileAiRequest,
    context: { model: string; promptVersion: string }
  ): Promise<StoreProfileAiResult>;
};

export type StoreProfileDetectionResult = {
  ai_used: boolean;
  profile: StoreProfile;
  unresolved_fields: string[];
};

export type WebsitePage = {
  body: string;
  headers?: Record<string, string>;
  url: string;
};

export type WebsiteFetcher = (url: string) => Promise<WebsitePage>;

export type StoreProfileDetectionService = {
  detect(websiteUrl: string): Promise<StoreProfileDetectionResult>;
};

type ParsedPage = {
  internalLinks: string[];
  meta: Record<string, string>;
  platformSignals: string[];
  profile: Omit<StoreProfile, 'canonical_domain' | 'website_url'>;
  text: string;
};

const DEFAULT_MODEL = 'gpt-5.4-nano';
const DEFAULT_PROMPT_VERSION = 'store-profile-v1';
const MAX_PAGE_CHARS = 1_000_000;
const MAX_AI_TEXT_CHARS = 16_000;
const ENRICHMENT_PATH_WORDS = ['about', 'contact', 'contacto', 'nosotros', 'ubicacion', 'ubicaciones', 'sucursales', 'tiendas'];

const CITY_STATE_PAIRS: Array<[string, string, string[]]> = [
  ['Aguascalientes', 'Aguascalientes', ['aguascalientes']],
  ['Cancún', 'Quintana Roo', ['cancun']],
  ['Ciudad de México', 'Ciudad de México', ['ciudad de mexico', 'cdmx', 'mexico city']],
  ['Guadalajara', 'Jalisco', ['guadalajara']],
  ['León', 'Guanajuato', ['leon']],
  ['Mérida', 'Yucatán', ['merida']],
  ['Monterrey', 'Nuevo León', ['monterrey']],
  ['Puebla', 'Puebla', ['puebla']],
  ['Querétaro', 'Querétaro', ['queretaro']],
  ['Tijuana', 'Baja California', ['tijuana']],
  ['Toluca', 'Estado de México', ['toluca']],
  ['Zapopan', 'Jalisco', ['zapopan']]
];

const STATE_ALIASES: Array<[string, string[]]> = [
  ['Aguascalientes', ['aguascalientes']],
  ['Baja California Sur', ['baja california sur']],
  ['Baja California', ['baja california']],
  ['Campeche', ['campeche']],
  ['Chiapas', ['chiapas']],
  ['Chihuahua', ['chihuahua']],
  ['Ciudad de México', ['ciudad de mexico', 'cdmx']],
  ['Coahuila', ['coahuila']],
  ['Colima', ['colima']],
  ['Durango', ['durango']],
  ['Estado de México', ['estado de mexico', 'edomex']],
  ['Guanajuato', ['guanajuato']],
  ['Guerrero', ['guerrero']],
  ['Hidalgo', ['hidalgo']],
  ['Jalisco', ['jalisco']],
  ['Michoacán', ['michoacan']],
  ['Morelos', ['morelos']],
  ['Nayarit', ['nayarit']],
  ['Nuevo León', ['nuevo leon']],
  ['Oaxaca', ['oaxaca']],
  ['Puebla', ['puebla']],
  ['Querétaro', ['queretaro']],
  ['Quintana Roo', ['quintana roo']],
  ['San Luis Potosí', ['san luis potosi']],
  ['Sinaloa', ['sinaloa']],
  ['Sonora', ['sonora']],
  ['Tabasco', ['tabasco']],
  ['Tamaulipas', ['tamaulipas']],
  ['Tlaxcala', ['tlaxcala']],
  ['Veracruz', ['veracruz']],
  ['Yucatán', ['yucatan']],
  ['Zacatecas', ['zacatecas']]
];

export function createStoreProfileDetectionService(options: {
  aiClient?: StoreProfileAiClient;
  fetchWebsite?: WebsiteFetcher;
  model?: string;
  promptVersion?: string;
} = {}): StoreProfileDetectionService {
  const aiClient = options.aiClient;
  const fetchWebsite = options.fetchWebsite ?? createNodeWebsiteFetcher();
  const model = options.model ?? DEFAULT_MODEL;
  const promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;

  return {
    async detect(inputUrl): Promise<StoreProfileDetectionResult> {
      const requestedUrl = normalizeWebsiteUrl(inputUrl);
      assertPublicWebsiteUrl(requestedUrl);
      const homePage = await fetchWebsite(requestedUrl);
      const resolvedUrl = normalizeWebsiteUrl(homePage.url || requestedUrl);
      assertPublicWebsiteUrl(resolvedUrl);

      const parsedPages = [parsePage(homePage.body.slice(0, MAX_PAGE_CHARS), resolvedUrl, homePage.headers ?? {})];
      for (const link of parsedPages[0].internalLinks.slice(0, 2)) {
        try {
          const page = await fetchWebsite(link);
          parsedPages.push(parsePage(page.body.slice(0, MAX_PAGE_CHARS), page.url || link, page.headers ?? {}));
        } catch {
          // Secondary pages improve enrichment, but the home page remains sufficient for a useful draft.
        }
      }

      let profile = mergeParsedProfiles(parsedPages, resolvedUrl);
      let aiUsed = false;
      if (aiClient && unresolvedFields(profile).length > 0) {
        const aiResult = await aiClient.detect(aiRequestFromPages(parsedPages, homePage.headers ?? {}, resolvedUrl), {
          model,
          promptVersion
        });
        profile = mergeAiResult(profile, aiResult, resolvedUrl);
        aiUsed = true;
      }

      return {
        ai_used: aiUsed,
        profile,
        unresolved_fields: unresolvedFields(profile)
      };
    }
  };
}

export function createNodeWebsiteFetcher(timeoutMs = 15_000): WebsiteFetcher {
  return async (url) => {
    let currentUrl = normalizeWebsiteUrl(url);
    let response: Response | undefined;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      assertPublicWebsiteUrl(currentUrl);
      await assertPublicDnsTarget(currentUrl);
      response = await fetch(currentUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'LudoraStoreProfileDetector/1.0'
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }
      const location = response.headers.get('location');
      if (!location || redirectCount === 5) {
        throw httpError(422, 'Website redirected too many times');
      }
      currentUrl = normalizeWebsiteUrl(new URL(location, currentUrl).toString());
      response = undefined;
    }
    if (!response) {
      throw httpError(422, 'Website could not be loaded');
    }
    if (!response.ok) {
      throw httpError(422, `Website returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('text/html')) {
      throw httpError(422, 'Website did not return HTML');
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_CHARS * 4) {
      throw httpError(422, 'Website response is too large');
    }
    return {
      body: (await response.text()).slice(0, MAX_PAGE_CHARS),
      headers: Object.fromEntries(response.headers.entries()),
      url: currentUrl
    };
  };
}

export function normalizeWebsiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw httpError(400, 'website_url is required');
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw httpError(400, 'website_url must be a valid HTTP or HTTPS URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError(400, 'website_url must be a valid HTTP or HTTPS URL');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString();
}

function assertPublicWebsiteUrl(value: string): void {
  const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    /^(?:fc|fd|fe8|fe9|fea|feb)[\da-f]*:/i.test(hostname) ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw httpError(400, 'website_url must reference a public website');
  }
}

async function assertPublicDnsTarget(value: string): Promise<void> {
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    return;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw httpError(422, 'Website hostname could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIpAddress(address))) {
    throw httpError(400, 'website_url must reference a public website');
  }
}

function isPrivateIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return (
    normalized === '::1' ||
    /^(?:fc|fd|fe8|fe9|fea|feb)[\da-f]*:/i.test(normalized) ||
    /^127\./.test(normalized) ||
    /^10\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^169\.254\./.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
  );
}

function parsePage(html: string, baseUrl: string, headers: Record<string, string>): ParsedPage {
  const meta = extractMeta(html);
  const jsonLd = extractJsonLd(html);
  const anchors = extractLinks(html, 'a', 'href', baseUrl);
  const text = visibleText(html);
  const jsonLdProfile = profileFromJsonLd(jsonLd, baseUrl);
  const [city, state] = inferLocation(text);
  const name =
    jsonLdProfile.name ||
    cleanStoreName(meta['og:site_name'] || meta['application-name'] || meta['og:title'] || meta['twitter:title'] || extractTitle(html));
  const socialUrls = [...jsonLdProfile.sameAs, ...anchors];
  const platformDetection = detectPlatform(html, headers, baseUrl);

  return {
    internalLinks: anchors.filter((link) => isEnrichmentLink(link, baseUrl)),
    meta,
    platformSignals: platformDetection.signals,
    profile: {
      city: jsonLdProfile.city || city,
      country: normalizeCountry(jsonLdProfile.country) || inferCountry(text, baseUrl),
      facebook_url: firstSocialUrl(socialUrls, 'facebook'),
      instagram_url: firstSocialUrl(socialUrls, 'instagram'),
      logo_url: jsonLdProfile.logo || bestLogo(html, meta, baseUrl),
      name,
      platform: platformDetection.platform,
      state: jsonLdProfile.state || state,
    },
    text
  };
}

function mergeParsedProfiles(pages: ParsedPage[], resolvedUrl: string): StoreProfile {
  const domain = canonicalDomain(resolvedUrl);
  const first = pages[0]?.profile ?? emptyParsedProfile();
  const profile = { ...first };
  for (const page of pages.slice(1)) {
    profile.name ||= page.profile.name;
    profile.instagram_url ||= page.profile.instagram_url;
    profile.facebook_url ||= page.profile.facebook_url;
    profile.city ||= page.profile.city;
    profile.state ||= page.profile.state;
    profile.country ||= page.profile.country;
    profile.logo_url ||= page.profile.logo_url;
    if (!profile.platform || profile.platform === 'custom') {
      profile.platform = page.profile.platform || profile.platform;
    }
  }
  return {
    canonical_domain: domain,
    ...profile,
    country: profile.country || (domain.endsWith('.mx') ? 'Mexico' : ''),
    platform: profile.platform || 'custom',
    website_url: resolvedUrl
  };
}

function mergeAiResult(profile: StoreProfile, ai: StoreProfileAiResult, baseUrl: string): StoreProfile {
  return {
    ...profile,
    city: profile.city || cleanText(ai.city),
    country: profile.country || normalizeCountry(ai.country),
    facebook_url: profile.facebook_url || canonicalSocialUrl(ai.facebookUrl, 'facebook'),
    instagram_url: profile.instagram_url || canonicalSocialUrl(ai.instagramUrl, 'instagram'),
    logo_url: profile.logo_url || resolveHttpUrl(ai.logoUrl, baseUrl),
    name: profile.name || cleanStoreName(ai.name),
    platform: !profile.platform || profile.platform === 'custom' ? normalizePlatform(ai.platform) || profile.platform : profile.platform,
    state: profile.state || cleanText(ai.state)
  };
}

function aiRequestFromPages(
  pages: ParsedPage[],
  headers: Record<string, string>,
  websiteUrl: string
): StoreProfileAiRequest {
  return {
    headers,
    meta: Object.assign({}, ...pages.map((page) => page.meta)),
    platformSignals: [...new Set(pages.flatMap((page) => page.platformSignals))],
    textExcerpt: pages.map((page) => page.text).join('\n').slice(0, MAX_AI_TEXT_CHARS),
    websiteUrl
  };
}

function unresolvedFields(profile: StoreProfile): string[] {
  return (['name', 'platform', 'instagram_url', 'facebook_url', 'city', 'state', 'country', 'logo_url'] as const).filter(
    (field) => !profile[field] || (field === 'platform' && profile.platform === 'custom')
  );
}

function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    const key = (attributes.property || attributes.name || attributes.itemprop || '').toLowerCase();
    const content = cleanText(attributes.content || '');
    if (key && content) {
      meta[key] = content;
    }
  }
  return meta;
}

function extractJsonLd(html: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      collectJsonLdRecords(JSON.parse(decodeHtml(match[1] ?? '')), records);
    } catch {
      // Invalid third-party JSON-LD should not prevent deterministic metadata extraction.
    }
  }
  return records;
}

function collectJsonLdRecords(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonLdRecords(item, output));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  output.push(record);
  if (Array.isArray(record['@graph'])) {
    record['@graph'].forEach((item) => collectJsonLdRecords(item, output));
  }
}

function profileFromJsonLd(records: Record<string, unknown>[], baseUrl: string): {
  city: string;
  country: string;
  logo: string;
  name: string;
  sameAs: string[];
  state: string;
} {
  const selected =
    records.find((record) => jsonLdTypes(record).some((type) => ['organization', 'store', 'localbusiness', 'onlinestore'].includes(type))) ??
    records[0] ??
    {};
  const address = selected.address && typeof selected.address === 'object' ? (selected.address as Record<string, unknown>) : {};
  const sameAs = Array.isArray(selected.sameAs) ? selected.sameAs : selected.sameAs ? [selected.sameAs] : [];
  return {
    city: cleanText(address.addressLocality),
    country: cleanText(address.addressCountry),
    logo: resolveHttpUrl(jsonLdUrl(selected.logo), baseUrl),
    name: cleanStoreName(selected.name),
    sameAs: sameAs.map(String),
    state: cleanText(address.addressRegion)
  };
}

function jsonLdTypes(record: Record<string, unknown>): string[] {
  const value = record['@type'];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item ?? '').toLowerCase());
}

function jsonLdUrl(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return cleanText(record.url || record.contentUrl);
  }
  return '';
}

function extractTitle(html: string): string {
  return cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
}

function extractLinks(html: string, tagName: string, attribute: string, baseUrl: string): string[] {
  const links: string[] = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  for (const tag of html.match(pattern) ?? []) {
    const value = parseAttributes(tag)[attribute];
    const resolved = resolveHttpUrl(value, baseUrl);
    if (resolved && !links.includes(resolved)) {
      links.push(resolved);
    }
  }
  return links;
}

function bestLogo(html: string, meta: Record<string, string>, baseUrl: string): string {
  const imageCandidate = meta['og:logo'] || meta.logo || meta['twitter:image'] || meta['og:image'];
  if (imageCandidate) {
    return resolveHttpUrl(imageCandidate, baseUrl);
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    if (/\b(?:apple-touch-icon|icon)\b/i.test(attributes.rel ?? '')) {
      const resolved = resolveHttpUrl(attributes.href, baseUrl);
      if (resolved) {
        return resolved;
      }
    }
  }
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    if (/logo/i.test(`${attributes.class ?? ''} ${attributes.id ?? ''} ${attributes.alt ?? ''}`)) {
      const resolved = resolveHttpUrl(attributes.src, baseUrl);
      if (resolved) {
        return resolved;
      }
    }
  }
  return '';
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const body = tag.replace(/^<\/?[a-z\d:-]+/i, '').replace(/\/?\s*>$/, '');
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of body.matchAll(pattern)) {
    attributes[(match[1] ?? '').toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function visibleText(html: string): string {
  return cleanText(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function inferLocation(text: string): [string, string] {
  const normalized = normalizeText(text);
  for (const [city, state, aliases] of CITY_STATE_PAIRS) {
    if (aliases.some((alias) => containsPhrase(normalized, alias))) {
      return [city, state];
    }
  }
  for (const [state, aliases] of STATE_ALIASES) {
    if (aliases.some((alias) => containsPhrase(normalized, alias))) {
      return ['', state];
    }
  }
  return ['', ''];
}

function inferCountry(text: string, baseUrl: string): string {
  const normalized = normalizeText(text);
  if (containsPhrase(normalized, 'mexico') || canonicalDomain(baseUrl).endsWith('.mx')) {
    return 'Mexico';
  }
  return '';
}

function detectPlatform(html: string, headers: Record<string, string>, baseUrl: string): { platform: string; signals: string[] } {
  const haystack = `${html}\n${JSON.stringify(headers)}\n${baseUrl}`.toLowerCase();
  if (/(?:^|\.)amazon\.[a-z.]+$/i.test(new URL(baseUrl).hostname)) {
    return { platform: 'amazon', signals: ['amazon hostname'] };
  }
  const platforms: Array<[string, string[]]> = [
    ['shopify', ['cdn.shopify.com', 'shopify.theme', 'window.shopify', 'myshopify.com', 'x-shopify']],
    ['woocommerce', ['wp-content/plugins/woocommerce', 'woocommerce-layout.css', 'wc-ajax=', 'wp-json/wc/']],
    ['godaddy_website_builder', ['dps_site_id', 'websites + marketing', 'godaddy website builder', 'server":"dps/']],
    ['wix', ['wixstatic.com', 'x-wix-request-id', 'wix-code-sdk']],
    ['squarespace', ['static1.squarespace.com', 'squarespace.com/universal', 'squarespace-context']],
    ['tiendanube', ['tiendanube.com', 'nuvemshop.com.br', 'storefront.nuvemshop']],
    ['prestashop', ['prestashop', 'modules/ps_']],
    ['magento', ['mage/cookies', 'magento_', 'x-magento']],
    ['bigcommerce', ['cdn11.bigcommerce.com', 'stencil-utils', 'x-bc-']]
  ];
  for (const [platform, markers] of platforms) {
    const signals = markers.filter((marker) => haystack.includes(marker));
    if (signals.length > 0) {
      return { platform, signals };
    }
  }
  return { platform: 'custom', signals: [] };
}

function firstSocialUrl(links: string[], platform: 'facebook' | 'instagram'): string {
  for (const link of links) {
    const canonical = canonicalSocialUrl(link, platform);
    if (canonical) {
      return canonical;
    }
  }
  return '';
}

function canonicalSocialUrl(value: unknown, platform: 'facebook' | 'instagram'): string {
  const stringValue = cleanText(value);
  if (!stringValue) {
    return '';
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(stringValue) ? stringValue : `https://${stringValue}`);
    const host = parsed.hostname.toLowerCase().replace(/^(?:www\.|m\.)/, '');
    if (host !== `${platform}.com`) {
      return '';
    }
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length === 0) {
      return '';
    }
    const blocked = platform === 'instagram' ? ['accounts', 'explore', 'p', 'reel', 'stories'] : ['events', 'plugins', 'share', 'sharer'];
    if (blocked.includes(pathParts[0].toLowerCase())) {
      return '';
    }
    if (platform === 'facebook' && pathParts[0].toLowerCase() === 'profile.php' && parsed.searchParams.get('id')) {
      return `https://facebook.com/profile.php?id=${encodeURIComponent(parsed.searchParams.get('id') ?? '')}`;
    }
    return `https://${platform}.com/${pathParts[0]}`;
  } catch {
    return '';
  }
}

function isEnrichmentLink(link: string, baseUrl: string): boolean {
  try {
    const parsed = new URL(link);
    return canonicalDomain(link) === canonicalDomain(baseUrl) && ENRICHMENT_PATH_WORDS.some((word) => parsed.pathname.toLowerCase().includes(word));
  } catch {
    return false;
  }
}

function resolveHttpUrl(value: unknown, baseUrl: string): string {
  const candidate = cleanText(value);
  if (!candidate || candidate.startsWith('data:')) {
    return '';
  }
  try {
    const parsed = new URL(candidate, baseUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function canonicalDomain(value: string): string {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
}

function normalizePlatform(value: unknown): string {
  const normalized = normalizeText(cleanText(value)).replace(/\s+/g, '_');
  const aliases: Record<string, string> = {
    godaddy: 'godaddy_website_builder',
    godaddy_websites_marketing: 'godaddy_website_builder',
    nuvemshop: 'tiendanube',
    wordpress_woocommerce: 'woocommerce'
  };
  return aliases[normalized] ?? normalized;
}

function normalizeCountry(value: unknown): string {
  const country = cleanText(value);
  const normalized = normalizeText(country);
  if (normalized === 'mx' || normalized === 'mexico') {
    return 'Mexico';
  }
  return country;
}

function cleanStoreName(value: unknown): string {
  let text = cleanText(value);
  for (const separator of [' | ', ' - ', ' – ', ' — ']) {
    if (text.includes(separator)) {
      text = text.split(separator, 1)[0] ?? text;
    }
  }
  return text.trim();
}

function cleanText(value: unknown): string {
  return decodeHtml(typeof value === 'string' || typeof value === 'number' ? String(value) : '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function containsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(normalizeText(phrase))}(?:$|[^a-z0-9])`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function emptyParsedProfile(): Omit<StoreProfile, 'canonical_domain' | 'website_url'> {
  return {
    city: '',
    country: '',
    facebook_url: '',
    instagram_url: '',
    logo_url: '',
    name: '',
    platform: '',
    state: ''
  };
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
