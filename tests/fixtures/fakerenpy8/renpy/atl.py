class RawBlock(object):
    __slots__ = ['loc', 'statements', 'animation']
    def __init__(self, statements):
        self.loc = ('game/script.rpy', 1); self.statements = statements; self.animation = False

class RawMultipurpose(object):
    __slots__ = ['loc', 'expressions', 'properties', 'warper', 'duration']
    def __init__(self, expressions, properties):
        self.loc = ('game/script.rpy', 1); self.expressions = expressions; self.properties = properties
