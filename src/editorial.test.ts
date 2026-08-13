import { editorialInsertion, editorialSkeleton, parseEditorial } from './editorial';

/** What the document looks like after an insertion at `at`. */
function afterInserting(content: string, at: number): string {
  const edit = editorialInsertion(content, at);
  return content.slice(0, edit.at) + edit.text + content.slice(edit.at);
}

const BLOCK = '> [!editorial] Editorial comment\n> Dieser Absatz funktioniert noch nicht.';

describe('parseEditorial', () => {
  it('finds a block standing at the top of a sheet', () => {
    const content = `${BLOCK}\n\nNell wartete am Fenster.\n`;
    const blocks = parseEditorial(content);
    expect(blocks).toHaveLength(1);
    expect(content.slice(blocks[0].from, blocks[0].to)).toBe(BLOCK);
  });

  it('finds a block sitting between two paragraphs', () => {
    const content = `Nell wartete am Fenster.\n\n${BLOCK}\n\nDann ging sie.\n`;
    const blocks = parseEditorial(content);
    expect(blocks).toHaveLength(1);
    expect(content.slice(blocks[0].from, blocks[0].to)).toBe(BLOCK);
  });

  it('reads the title written after the identifier', () => {
    expect(parseEditorial(BLOCK)[0].title).toBe('Editorial comment');
  });

  it('leaves the title empty when none was written', () => {
    expect(parseEditorial('> [!editorial]\n> Funktioniert noch nicht.')[0].title).toBe('');
  });

  it('strips the quote marker from the body', () => {
    expect(parseEditorial(BLOCK)[0].body).toBe('Dieser Absatz funktioniert noch nicht.');
  });

  it('keeps the paragraph breaks inside a longer body', () => {
    const content = [
      '> [!editorial] Editorial comment',
      '> Nells Nervosität kommt nicht raus.',
      '>',
      '> - Der Herzschlag steht zu oft da',
      '> - Der Dialog bleibt zu ruhig',
    ].join('\n');
    expect(parseEditorial(content)[0].body).toBe(
      'Nells Nervosität kommt nicht raus.\n\n- Der Herzschlag steht zu oft da\n- Der Dialog bleibt zu ruhig'
    );
  });

  it('accepts a folded block', () => {
    expect(parseEditorial('> [!editorial]- Editorial comment\n> Text.')[0].title).toBe(
      'Editorial comment'
    );
  });

  it('accepts a block written to start open', () => {
    expect(parseEditorial('> [!editorial]+ Editorial comment\n> Text.')[0].title).toBe(
      'Editorial comment'
    );
  });

  it('matches the identifier whatever its case', () => {
    // Obsidian ignores case on a callout type, so the parser has to agree —
    // otherwise a block Obsidian renders would be one the drawer cannot see.
    expect(parseEditorial('> [!Editorial] Editorial comment\n> Text.')).toHaveLength(1);
  });

  it('ends the block at a blank line', () => {
    const content = `${BLOCK}\n\n> Ein gewöhnliches Zitat.`;
    expect(content.slice(0, parseEditorial(content)[0].to)).toBe(BLOCK);
  });

  it('ends the block at a line without the quote marker', () => {
    const content = `${BLOCK}\nNell wartete am Fenster.`;
    expect(content.slice(0, parseEditorial(content)[0].to)).toBe(BLOCK);
  });

  it('closes a block that ends with the file', () => {
    expect(parseEditorial(BLOCK)[0].to).toBe(BLOCK.length);
  });

  it('ignores a callout of another type', () => {
    expect(parseEditorial('> [!note] Hinweis\n> Text.')).toEqual([]);
  });

  it('ignores a plain blockquote', () => {
    expect(parseEditorial('> Nur ein Zitat.\n> Und noch eins.')).toEqual([]);
  });

  it('returns several blocks in document order', () => {
    const content = `${BLOCK}\n\nNell wartete.\n\n> [!editorial]\n> Und hier auch nicht.`;
    const blocks = parseEditorial(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].from).toBeLessThan(blocks[1].from);
    expect(blocks[1].body).toBe('Und hier auch nicht.');
  });

  it('reads a sheet with CRLF line endings', () => {
    // Obsidian writes LF, but a manuscript can arrive from anywhere.
    const content = '> [!editorial] Editorial comment\r\n> Funktioniert noch nicht.\r\n';
    const blocks = parseEditorial(content);
    expect(blocks[0].title).toBe('Editorial comment');
    expect(blocks[0].body).toBe('Funktioniert noch nicht.');
  });

  it('finds nothing in a sheet without one', () => {
    expect(parseEditorial('Nell wartete am Fenster.\n')).toEqual([]);
  });
});

describe('editorialSkeleton', () => {
  it('writes a callout carrying its own title', () => {
    expect(editorialSkeleton().text).toBe('> [!editorial] Editorial comment\n> ');
  });

  it('puts the caret in the body rather than in the marker', () => {
    const { text, caret } = editorialSkeleton();
    expect(text.slice(caret)).toBe('');
    expect(text.slice(0, caret)).toContain('\n> ');
  });

  it('writes a block the parser reads back', () => {
    // The two halves have to agree: a skeleton the parser cannot see would be
    // a command that writes a block the drawer never shows.
    expect(parseEditorial(editorialSkeleton().text)).toHaveLength(1);
  });
});

describe('editorialInsertion', () => {
  it('writes into an empty sheet without padding it', () => {
    expect(afterInserting('', 0)).toBe(editorialSkeleton().text);
  });

  it('separates the block from the prose it is written above', () => {
    expect(afterInserting('Nell wartete am Fenster.\n', 0)).toBe(
      `${editorialSkeleton().text}\n\nNell wartete am Fenster.\n`
    );
  });

  it('separates the block from the prose above it', () => {
    // Adjacent lines: without the blank line the callout would swallow the
    // paragraph below it, and Obsidian would draw one box around both.
    expect(afterInserting('Nell wartete.\nDann ging sie.\n', 14)).toBe(
      `Nell wartete.\n\n${editorialSkeleton().text}\n\nDann ging sie.\n`
    );
  });

  it('adds no blank line where the sheet already has one', () => {
    expect(afterInserting('Nell wartete.\n\nDann ging sie.\n', 15)).toBe(
      `Nell wartete.\n\n${editorialSkeleton().text}\n\nDann ging sie.\n`
    );
  });

  it('appends at the end of a sheet', () => {
    expect(afterInserting('Nell wartete.\n', 14)).toBe(
      `Nell wartete.\n\n${editorialSkeleton().text}`
    );
  });

  it('starts the block on its own line when the caret sits mid-sentence', () => {
    // A callout has to begin a line, so the insertion point moves to the start
    // of the caret's line rather than splitting the sentence in half.
    expect(afterInserting('Nell wartete am Fenster.\n', 5)).toBe(
      `${editorialSkeleton().text}\n\nNell wartete am Fenster.\n`
    );
  });

  it('leaves the caret in the body of what it wrote', () => {
    const content = 'Nell wartete.\n\nDann ging sie.\n';
    const edit = editorialInsertion(content, 15);
    const next = content.slice(0, edit.at) + edit.text + content.slice(edit.at);

    const block = parseEditorial(next)[0];
    expect(edit.caret).toBeGreaterThan(block.from);
    expect(edit.caret).toBeLessThanOrEqual(block.to);
    expect(next.slice(0, edit.caret).endsWith('\n> ')).toBe(true);
  });

  it('writes a block the parser finds among the prose', () => {
    const next = afterInserting('Nell wartete.\n\nDann ging sie.\n', 15);
    expect(parseEditorial(next)).toHaveLength(1);
  });
});
