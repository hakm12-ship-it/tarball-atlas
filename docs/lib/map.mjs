// Split along the longer axis. Each leaf keeps its exact share of the total area.
export function layout(items, width, height) {
  if (!items.length || !width || !height) return [];
  const areas = [];
  const split = (list, total, x, y, w, h) => {
    if (list.length === 1) {
      areas.push({ ...list[0], x, y, w, h });
      return;
    }
    let cut = 1;
    let weight = list[0].weight;
    while (
      cut < list.length - 1 &&
      Math.abs(weight + list[cut].weight - total / 2) <
        Math.abs(weight - total / 2)
    ) {
      weight += list[cut++].weight;
    }
    const fraction = weight / total;
    if (w >= h) {
      const edge = w * fraction;
      split(list.slice(0, cut), weight, x, y, edge, h);
      split(list.slice(cut), total - weight, x + edge, y, w - edge, h);
    } else {
      const edge = h * fraction;
      split(list.slice(0, cut), weight, x, y, w, edge);
      split(list.slice(cut), total - weight, x, y + edge, w, h - edge);
    }
  };
  split(
    items,
    items.reduce((sum, item) => sum + item.weight, 0),
    0,
    0,
    width,
    height,
  );
  return areas;
}
