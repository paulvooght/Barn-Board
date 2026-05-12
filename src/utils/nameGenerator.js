// Random route-name suggester. Used as a placeholder hint on the create form.
// Pairs an adjective with a noun, mostly drawn from barn/farm/climbing imagery.

const ADJECTIVES = [
  'Barn', 'Dusty', 'Rusty', 'Wild', 'Crooked', 'Twisted', 'Stormy', 'Frosty',
  'Midnight', 'Smoky', 'Howling', 'Sleepy', 'Lonely', 'Crimson', 'Iron', 'Velvet',
  'Bronze', 'Hollow', 'Burning', 'Silver', 'Lazy', 'Mighty', 'Sneaky', 'Salty',
  'Whiskey', 'Crooked', 'Sunset', 'Moonlit', 'Cold', 'Fevered', 'Reckless', 'Quiet',
  'Loose', 'Brittle', 'Sharp', 'Slippery', 'Tangled', 'Ragged', 'Hungry', 'Thirsty',
];

const NOUNS = [
  'Burner', 'Rooster', 'Pitchfork', 'Stallion', 'Bandit', 'Hayride', 'Lasso',
  'Anvil', 'Mustang', 'Crow', 'Hawk', 'Coyote', 'Bull', 'Heifer', 'Saddle',
  'Hammer', 'Plough', 'Silo', 'Granary', 'Boots', 'Spurs', 'Bridle', 'Rodeo',
  'Cowpoke', 'Wrangler', 'Drifter', 'Outlaw', 'Whip', 'Tractor', 'Holler',
  'Dyno', 'Crimp', 'Pinch', 'Sloper', 'Mantle', 'Crux', 'Gaston', 'Heel',
  'Pump', 'Send', 'Flagger', 'Edge', 'Hook', 'Roof', 'Arete',
];

const SPECIALS = [
  'Barn Burner', 'Hay Maker', 'Rough Rider', 'Cold Shoulder', 'Cattle Drive',
  'Last Light', 'Big Sky', 'Thunder Roll', 'Wagon Wheel', 'Lone Pine',
  'Old Dog', 'Sundown', 'Fence Hopper', 'Crow’s Foot', 'Goat Path',
  'Slow Burn', 'Heel of the Boot', 'Greasy Crimp', 'Pump Town', 'Crux Hour',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateRouteName() {
  // ~25% chance of a hand-picked phrase, otherwise adjective + noun.
  if (Math.random() < 0.25) return pick(SPECIALS);
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}
