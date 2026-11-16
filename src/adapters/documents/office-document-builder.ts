/** Builds Word documents and slide decks the bot sends back in WhatsApp. */
import type { DocumentBuilder, DocumentSpec, OutgoingFile } from '../../core/types.js';
import { UserInputError } from '../../core/errors.js';
import { buildDocx } from './docx-builder.js';
import { normalizeSpec } from './document-text.js';
import { buildPptx } from './pptx-builder.js';

export class OfficeDocumentBuilder implements DocumentBuilder {
  async build(raw: DocumentSpec): Promise<OutgoingFile> {
    const spec = normalizeSpec(raw);
    if (!spec.sections.length) throw new UserInputError('The document has no content');
    return spec.format === 'pptx' ? buildPptx(spec) : buildDocx(spec);
  }
}
