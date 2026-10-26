"""Generate the original, freely reusable tiny font used by font-resource tests.

Requires fontTools only for regeneration; normal tests read the resulting TTF.
The font contains a deliberately simple A glyph, with no third-party outlines.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

builder = FontBuilder(1000, isTTF=True)
builder.setupGlyphOrder([".notdef", "space", "A"])
builder.setupCharacterMap({32: "space", 65: "A"})
glyphs = {}
for name in [".notdef", "space", "A"]:
    pen = TTGlyphPen(None)
    if name == "A":
        pen.moveTo((50, 0))
        pen.lineTo((350, 750))
        pen.lineTo((650, 0))
        pen.lineTo((500, 0))
        pen.lineTo((350, 450))
        pen.lineTo((200, 0))
        pen.closePath()
    glyphs[name] = pen.glyph()
builder.setupGlyf(glyphs)
builder.setupHorizontalMetrics({name: (700, 0) for name in glyphs})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable({"familyName": "Muxivra Test Attached", "styleName": "Regular", "uniqueFontIdentifier": "MuxivraTestAttached-Regular", "fullName": "Muxivra Test Attached Regular", "psName": "MuxivraTestAttached-Regular", "version": "Version 1.0"})
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
builder.setupMaxp()
builder.font["head"].created = builder.font["head"].modified = 0
builder.save(Path(__file__).with_name("muxivra-test.ttf"))
