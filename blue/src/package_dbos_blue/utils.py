# Bump on any change a launcher pinned to an older commit could not survive.
CONTRACT = 1


def registrable_domain(host) -> str:
    """The registrable domain of a host: its last two labels, the port of
    io.github.getcolors.dbos.utils/registrable-domain."""
    return ".".join(str(host or "").split(".")[-2:])


def par_lookup(key: str) -> str:
    """Jinja expression resolving a secret under the one parameter namespace
    every colour shares; identical bytes in green, red, and blue."""
    return "{{ lookup('env','COLORS_PAR_" + key.upper().replace("-", "_") + "') }}"
