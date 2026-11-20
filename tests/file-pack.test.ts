import { packFile, unpackFile } from '../src/core/file-pack';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

// 1. Pack and unpack binary file
{
  const filename = 'document.pdf';
  const mime = 'application/pdf';
  const data = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  const packed = packFile(filename, mime, data);
  const unpacked = unpackFile(packed);

  assert(unpacked.isFile === true, 'Should be detected as file');
  assert(unpacked.file!.name === filename, 'Filename matches');
  assert(unpacked.file!.mime === mime, 'MIME matches');
  assert(unpacked.file!.data.length === data.length, 'Data length matches');
  for (let i = 0; i < data.length; i++) {
    assert(unpacked.file!.data[i] === data[i], `Byte ${i} matches`);
  }
}

// 2. Regular plain text payload should not be detected as file
{
  const plainText = new TextEncoder().encode('Hello world, this is a plain message.');
  const res = unpackFile(plainText);
  assert(res.isFile === false, 'Plain text should not be detected as file');
}

// 3. UTF-8 international filename
{
  const filename = 'kunci_rahasia_🔒.key';
  const mime = 'application/octet-stream';
  const data = new Uint8Array([1, 2, 3, 4, 5]);

  const packed = packFile(filename, mime, data);
  const unpacked = unpackFile(packed);
  assert(unpacked.isFile === true, 'UTF8 file should be detected');
  assert(unpacked.file!.name === filename, 'UTF8 filename preserved');
}

console.log('File pack test suite passed.');
