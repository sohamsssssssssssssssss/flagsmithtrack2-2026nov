export const products = [
  { id: "glow", name: "Glow Table Lamp", price: 4800, icon: "💡" },
  { id: "dune", name: "Dune Ceramic Mug", price: 1600, icon: "☕" },
  { id: "grove", name: "Grove Planter", price: 2400, icon: "🪴" },
  { id: "drift", name: "Drift Throw", price: 6200, icon: "🧶" },
];

export function fuzzyMatch(query: string, name: string) {
  const words = name.split(" ");
  return name.includes(query) || query.split(/\s+/).every((term) => words.some((word) => {
    if (word.includes(term)) return true;
    if (term.length < 3 || Math.abs(word.length - term.length) > 1) return false;
    const mismatch = [...term].findIndex((letter, index) => letter !== word[index]);
    if (mismatch === -1) return true;
    const rest = term.slice(mismatch);
    const other = word.slice(mismatch);
    return rest.slice(1) === other || rest === other.slice(1) || rest.slice(1) === other.slice(1);
  }));
}
