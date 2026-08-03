export const EMPTY = { type: 'FeatureCollection', features: [] };

export const json = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
};
