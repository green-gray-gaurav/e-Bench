import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function sampleBook() {
  const doc = await PDFDocument.create();
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(.17, .21, .19), green = rgb(.25, .37, .28);
  const chapters = [
    {
      label: '01 / A WAY OF SEEING', title: 'Thinking in systems', subtitle: 'A small field guide to connected things',
      blocks: [
        ['heading', 'The whole is more than the parts'],
        ['body', 'A system is a collection of elements connected in a way that produces a pattern of behavior over time. A garden, a city, and a conversation can all be understood as systems.'],
        ['body', 'To understand a system, look beyond its individual parts. Ask how those parts influence one another, what accumulates, and which signals change the next action.'],
        ['quote', 'Connections often explain more than the components themselves.'],
        ['heading', 'Three useful questions'],
        ['body', 'What are the elements? How are they connected? What purpose or behavior emerges from those connections? These questions turn a list of things into a model you can reason about.'],
        ['body', 'Imagine a cup of tea cooling on a desk. The tea, the cup, and the surrounding air exchange heat. The temperature difference drives the rate of cooling, so the process slows as the tea approaches room temperature.'],
        ['heading', 'Read actively'],
        ['body', 'Select a sentence you want to understand. Ask for a plain-language explanation, a diagram, or a code example. Save the ideas that matter; your notes will follow the order of the book.'],
      ],
    },
    {
      label: '02 / PATTERNS OVER TIME', title: 'Feedback changes things', subtitle: 'Why a cause can become its own consequence',
      blocks: [
        ['heading', 'Reinforcing loops'],
        ['body', 'In a reinforcing feedback loop, a change creates effects that amplify the original change. Money earning interest is a familiar example: a larger balance earns more interest, which increases the balance again.'],
        ['body', 'Reinforcement can create growth or decline. A habit becomes easier with practice, while an unused skill becomes harder to recall and is practiced even less. The direction depends on the starting conditions.'],
        ['quote', 'A feedback loop connects the result of an action to the next action.'],
        ['heading', 'Balancing loops'],
        ['body', 'A balancing feedback loop opposes change and moves a system toward a target. A thermostat compares room temperature with a desired temperature and adjusts heating in response to the difference.'],
        ['body', 'Delays matter. If a controller reacts to old information, it can overcorrect. A shower that alternates between too hot and too cold is a simple example of adjustment interacting with delayed feedback.'],
        ['heading', 'Try a prediction'],
        ['body', 'Before changing a system, predict what will happen immediately and what might happen later. The difference between those answers often reveals a hidden loop or a delay.'],
      ],
    },
    {
      label: '03 / MAKING A MODEL', title: 'Stocks, flows, and time', subtitle: 'A bathtub is a surprisingly useful model',
      blocks: [
        ['heading', 'What accumulates?'],
        ['body', 'A stock is something that accumulates: water in a bathtub, books on a shelf, or knowledge remembered by a learner. A flow is a rate that increases or decreases a stock.'],
        ['body', 'The amount of water changes according to the inflow from the tap minus the outflow through the drain. If the two rates are equal, the level stays steady even though water continues to move.'],
        ['quote', 'A stable quantity can hide a great deal of activity.'],
        ['heading', 'A simple numerical model'],
        ['body', 'Suppose a tank contains 20 liters. Water enters at 5 liters per minute and leaves at 3 liters per minute. The net flow is 2 liters per minute, so after 10 minutes the tank contains 40 liters, assuming no capacity limit.'],
        ['body', 'Models deliberately leave things out. This model ignores evaporation, pressure, and a changing drain rate. A useful model is detailed enough to answer the question without hiding the mechanism.'],
        ['heading', 'Bring it back to learning'],
        ['body', 'Practice adds to remembered knowledge, while forgetting reduces it. Spaced review changes those rates over time. Your study bench helps you turn a selected passage into an explanation and a note you can revisit.'],
      ],
    },
  ];
  function wrap(text, font, size, width) {
    const lines = []; let line = '';
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  chapters.forEach((chapter, index) => {
    const page = doc.addPage([612, 792]);
    page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(.998, .994, .978) });
    page.drawText('BENCH  /  READING SERIES', { x: 58, y: 744, size: 9, font: sans, color: green });
    page.drawLine({ start: { x: 58, y: 725 }, end: { x: 554, y: 725 }, thickness: .6, color: rgb(.8,.82,.77) });
    page.drawText(chapter.label, { x: 58, y: 697, size: 9, font: sans, color: green });
    page.drawText(chapter.title, { x: 58, y: 651, size: 31, font: serif, color: ink });
    page.drawText(chapter.subtitle, { x: 58, y: 626, size: 12, font: italic, color: green });
    let y = 582;
    for (const [kind, text] of chapter.blocks) {
      const font = kind === 'heading' ? sans : kind === 'quote' ? italic : serif;
      const size = kind === 'heading' ? 11 : kind === 'quote' ? 15 : 12;
      const lines = wrap(text, font, size, 490);
      if (kind === 'heading') y -= 7;
      if (kind === 'quote') {
        page.drawLine({ start: { x: 58, y: y+4 }, end: { x: 58, y: y-lines.length*19+10 }, thickness: 2, color: green });
      }
      for (const line of lines) {
        page.drawText(line, { x: kind === 'quote' ? 70 : 58, y, size, font, color: kind === 'quote' ? green : ink }); y -= kind === 'heading' ? 18 : 18;
      }
      y -= kind === 'quote' ? 16 : 12;
    }
    page.drawLine({ start: { x: 58, y: 47 }, end: { x: 554, y: 47 }, thickness: .5, color: rgb(.8,.82,.77) });
    page.drawText('An original sample book for Study Bench', { x: 58, y: 30, size: 8, font: sans, color: green });
    page.drawText(String(index + 1).padStart(2, '0'), { x: 540, y: 30, size: 9, font: sans, color: green });
  });
  doc.setTitle('Thinking in Systems - A Study Bench Field Guide');
  doc.setAuthor('Study Bench');
  return Buffer.from(await doc.save());
}
