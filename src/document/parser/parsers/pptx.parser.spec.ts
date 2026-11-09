import * as JSZip from 'jszip';
import { parsePptx } from './pptx.parser';

describe('parsePptx', () => {
  it('extracts slide headings and text through the ZIP parser', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>
          <p:sp>
            <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>Reading methods</a:t></a:r></a:p></p:txBody>
          </p:sp>
          <p:sp>
            <p:txBody><a:p><a:r><a:t>Read the material carefully.</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </p:spTree></p:cSld>
      </p:sld>`,
    );

    const content = await parsePptx(
      await zip.generateAsync({ type: 'nodebuffer' }),
    );

    expect(content).toContain('## \u5e7b\u706f\u7247 1');
    expect(content).toContain('### Reading methods');
    expect(content).toContain('Read the material carefully.');
    expect(content.match(/Reading methods/g)).toHaveLength(1);
  });
});
