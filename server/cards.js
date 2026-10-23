// The card: the photo merged into the event's PSD template with the name and the scores
// (print/compose.js, the same code as the print agent). The server makes it when the photo arrives,
// so the very same picture goes to the printer and in the mail, and it is ready when the call
// answers. Template: the one uploaded for the event in the admin, else the local one
// (PRINT_TEMPLATE, a .psd or a folder with the newest .psd). With neither there is no card here:
// the print agent then uses its own template, and the mail gets the photo as it is.
import path from 'node:path';
import {
  compose, findTemplate, loadTemplate, printValues,
} from '../print/compose.js';

/** options: { store, localTemplate, photoLayers, log } */
export function createCards({
  store, localTemplate, photoLayers, log = () => {},
}) {
  const options = photoLayers ? { photoLayers } : {};
  // read PSDs, kept in memory: by event { version, tpl }, and the local one by file stamp
  const uploaded = new Map();
  let local = { stamp: null, tpl: null };

  async function templateFor(event) {
    if (event.template) {
      const known = uploaded.get(event.slug);
      if (known?.version === event.template.version) return known.tpl;
      const dir = store.templatesDir(event.slug);
      const tpl = await loadTemplate(path.join(dir, `${event.template.version}.psd`), { ...options, fontsDir: path.join(dir, 'fonts') });
      uploaded.set(event.slug, { version: event.template.version, tpl });
      return tpl;
    }
    if (!localTemplate) return null;
    const found = await findTemplate(localTemplate);
    if (!found) return null;
    const stamp = `${found.file}:${found.info.mtimeMs}:${found.info.size}`;
    if (local.stamp !== stamp) {
      local = { stamp, tpl: await loadTemplate(found.file, options) };
      log(`Card: template ${path.basename(found.file)} (${local.tpl.width}×${local.tpl.height} px).`);
    }
    return local.tpl;
  }

  return {
    /** The card as JPEG, or null when there is no template for the event. */
    async make(event, photo, { userId, scores }) {
      const tpl = await templateFor(event);
      return tpl ? compose(photo, tpl, printValues({ userId, scores })) : null;
    },
  };
}
