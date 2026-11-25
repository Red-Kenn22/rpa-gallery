"""Ren'Py 8.x-shaped screen language AST (just enough for a Replay gallery screen)."""

class SLNode(object):
    def __init__(self, loc=('game/screens.rpy', 1), **kw):
        self.location = loc
        self.serial = 0
        for k, v in kw.items(): setattr(self, k, v)

class SLBlock(SLNode):
    pass

class SLScreen(SLBlock):
    pass

class SLDisplayable(SLBlock):
    pass
