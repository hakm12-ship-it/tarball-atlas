const marker = '<script id="report-data" type="application/json">';
const close = '</script>';

export function embedReport(template, before, after) {
  const start = template.indexOf(marker);
  const end = template.indexOf(close, start + marker.length);
  if (start < 0 || end < 0)
    throw new Error('The offline viewer template is incomplete.');
  const json = JSON.stringify({ before, after }).replace(/</g, '\\u003c');
  return template.slice(0, start + marker.length) + json + template.slice(end);
}
