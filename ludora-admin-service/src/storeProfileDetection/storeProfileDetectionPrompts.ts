import type { StoreProfileAiRequest } from './storeProfileDetectionService.js';

export function systemPromptForStoreProfileDetection(): string {
  return [
    'You complete a structured ecommerce store profile using only supplied website evidence.',
    'Extract the public store name, ecommerce platform, official Instagram and Facebook profile URLs, city, state, country, and logo URL.',
    'Use stable platform identifiers such as shopify, woocommerce, godaddy_website_builder, wix, squarespace, tiendanube, prestashop, magento, bigcommerce, amazon, or custom.',
    'Return an empty string when evidence does not support a field. Never invent social profiles, locations, logos, or platform details.'
  ].join(' ');
}

export function userPromptForStoreProfileDetection(request: StoreProfileAiRequest): string {
  return [
    `Website URL: ${request.websiteUrl}`,
    `HTTP headers: ${JSON.stringify(request.headers)}`,
    `Metadata: ${JSON.stringify(request.meta)}`,
    `Detected platform signals: ${JSON.stringify(request.platformSignals)}`,
    `Visible website text: ${request.textExcerpt}`
  ].join('\n');
}
