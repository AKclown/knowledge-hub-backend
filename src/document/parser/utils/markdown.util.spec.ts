import { decodeUploadFilename } from './markdown.util';

describe('decodeUploadFilename', () => {
  const filename = '\u7533\u8bba\u603b\u7ed3\u8bfe.pptx';

  it('restores a GBK filename decoded as Latin-1', () => {
    const original = Buffer.from('c9eac2dbd7dcbde1bfce2e70707478', 'hex');

    expect(decodeUploadFilename(original.toString('latin1'))).toBe(filename);
  });

  it('restores a UTF-8 filename decoded as Latin-1', () => {
    const original = Buffer.from(filename, 'utf8').toString('latin1');

    expect(decodeUploadFilename(original)).toBe(filename);
  });

  it.each([filename, 'report.pptx', 'caf\u00e9.pptx', '\u00ff.pptx'])(
    'preserves a filename that does not need or support decoding: %s',
    (original) => {
      expect(decodeUploadFilename(original)).toBe(original);
    },
  );

  it.each([undefined, null, ''])(
    'handles an empty filename: %s',
    (original) => {
      expect(decodeUploadFilename(original)).toBe('');
    },
  );
});
