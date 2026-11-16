/** Builds Word documents and slide decks the bot sends back in WhatsApp. */
import type { DocumentBuilder, DocumentSpec, OutgoingFile, ReportRenderer } from '../../core/types.js';
import { UserInputError } from '../../core/errors.js';
import { buildDocx } from './docx-builder.js';
import { normalizeSpec } from './document-text.js';
import { buildPptx } from './pptx-builder.js';

export class OfficeDocumentBuilder implements DocumentBuilder {
  /** @param charts draws chart pictures for Word documents (slides use native PowerPoint charts). */
  constructor(private readonly charts?: ReportRenderer) {}

  async build(raw: DocumentSpec): Promise<OutgoingFile> {
    const spec = normalizeSpec(raw);
    if (!spec.sections.length) throw new UserInputError('The document has no content');
    return spec.format === 'pptx' ? buildPptx(spec) : buildDocx(spec, this.charts);
  }
}
