"""Ren'Py 8.x-shaped AST: __slots__ objects, unset (default) slots omitted from state."""
from renpy.astsupport import PyExpr

class PyCode(object):
    __slots__ = ['source', 'filename', 'linenumber', 'mode', 'py', 'hashcode', 'col_offset']
    def __init__(self, source, line=1, mode='exec'):
        self.source = PyExpr(source, 'game/script.rpy', line); self.filename = 'game/script.rpy'
        self.linenumber = line; self.mode = mode; self.py = 3; self.hashcode = 1234; self.col_offset = 0
    def __getstate__(self):
        return (1, self.source, (self.filename, self.linenumber), self.mode, self.py, self.hashcode, self.col_offset)
    def __setstate__(self, s): pass

class Node(object):
    __slots__ = ['name', 'filename', 'linenumber', 'next', 'col_offset']
    def __init__(self, _lineno, **kw):
        self.filename = 'game/script.rpy'; self.linenumber = _lineno; self.name = ('game/script.rpy', 1, _lineno)
        for k, v in kw.items(): setattr(self, k, v)

def mk(name, slots):
    return type(name, (Node,), {'__slots__': slots, '__module__': 'renpy.ast'})

Say = mk('Say', ['who', 'who_fast', 'what', 'with_', 'interact', 'arguments', 'attributes', 'temporary_attributes', 'identifier', 'explicit_identifier'])
TranslateSay = type('TranslateSay', (Say,), {'__slots__': ['alternate', 'language'], '__module__': 'renpy.ast'})
Init = mk('Init', ['block', 'priority'])
Label = mk('Label', ['block', 'parameters', 'hide'])
Python = mk('Python', ['hide', 'code', 'store'])
Image = mk('Image', ['imgname', 'code', 'atl'])
Define = mk('Define', ['store', 'varname', 'index', 'operator', 'code'])
Show = mk('Show', ['imspec', 'atl'])
Scene = mk('Scene', ['imspec', 'layer', 'atl'])
Menu = mk('Menu', ['items', 'set', 'with_', 'has_caption', 'arguments', 'item_arguments'])
If = mk('If', ['entries'])
Pass = mk('Pass', [])
Jump = mk('Jump', ['target', 'expression', 'global_label'])
Translate = mk('Translate', ['identifier', 'alternate', 'language', 'block', 'after'])
EndTranslate = mk('EndTranslate', [])
TranslateBlock = mk('TranslateBlock', ['language', 'block'])
UserStatement = mk('UserStatement', ['line', 'parsed', 'block', 'subparses', 'code_block', 'translatable', 'rollback'])
Screen = mk('Screen', ['screen'])
NewFancyNode = mk('NewFancyNode', ['block'])
Hide = mk('Hide', ['imspec'])
Return = mk('Return', ['expression'])
Call = mk('Call', ['label', 'arguments', 'expression', 'global_label'])
