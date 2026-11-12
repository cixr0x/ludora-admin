export function storeItemVisibilityLabel(storeActive: unknown) {
  switch (storeActive) {
    case true:
    case 'true':
      return 'Visible';
    case false:
    case 'false':
      return 'Hidden';
    default:
      return 'Unknown';
  }
}
