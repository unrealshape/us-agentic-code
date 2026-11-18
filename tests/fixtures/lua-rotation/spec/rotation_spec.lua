local rotation = require("rotation")

describe("rotation.next_spell", function()
  it("waehlt den Zauber mit der hoechsten Prioritaet", function()
    local spells = {
      { name = "Fireball", priority = 5, cooldown = 0 },
      { name = "Pyroblast", priority = 10, cooldown = 0 },
    }
    assert.are.equal("Pyroblast", rotation.next_spell(spells))
  end)

  it("liefert nil ohne Zauber", function()
    assert.is_nil(rotation.next_spell({}))
  end)
end)
