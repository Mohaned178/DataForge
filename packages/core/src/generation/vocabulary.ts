import type { WeightedChoice } from '../random/random-stream';

export const FIRST_NAMES = [
  'Amara', 'Ben', 'Chen', 'Dalia', 'Elif', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jonas',
  'Kemi', 'Liam', 'Maya', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sami', 'Tara',
  'Umar', 'Vera', 'Wei', 'Ximena', 'Yusuf', 'Zara', 'Aiden', 'Bianca', 'Carlos', 'Dana',
] as const;

export const LAST_NAMES = [
  'Adeyemi', 'Becker', 'Costa', 'Dubois', 'Eriksen', 'Fischer', 'Garcia', 'Hassan', 'Ivanova', 'Jensen',
  'Kowalski', 'Lopez', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quintero', 'Rossi', 'Silva', 'Tanaka',
  'Ueda', 'Varga', 'Wagner', 'Xu', 'Yilmaz', 'Zhang', 'Ahmed', 'Brown', 'Chowdhury', 'Diaz',
] as const;

export const COUNTRIES: readonly WeightedChoice<string>[] = [
  { value: 'US', weight: 30 },
  { value: 'DE', weight: 12 },
  { value: 'GB', weight: 12 },
  { value: 'FR', weight: 10 },
  { value: 'EG', weight: 8 },
  { value: 'IN', weight: 8 },
  { value: 'BR', weight: 7 },
  { value: 'JP', weight: 7 },
  { value: 'CA', weight: 6 },
];

export const PRODUCT_ADJECTIVES = ['Classic', 'Compact', 'Deluxe', 'Everyday', 'Modern', 'Rugged', 'Smart', 'Ultra'] as const;
export const PRODUCT_MATERIALS = ['Bamboo', 'Canvas', 'Ceramic', 'Cotton', 'Glass', 'Leather', 'Steel', 'Wool'] as const;
export const PRODUCT_NOUNS = ['Backpack', 'Blender', 'Desk Lamp', 'Headphones', 'Kettle', 'Mug', 'Notebook', 'Sneakers', 'Watch', 'Water Bottle'] as const;
