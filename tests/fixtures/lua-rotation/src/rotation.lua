local M = {}

--- Gibt den Namen des naechsten Zaubers zurueck.
-- @param spells table Liste von { name = string, priority = number, cooldown = number }
-- @return string|nil
function M.next_spell(spells)
  local best
  for _, spell in ipairs(spells) do
    if best == nil or spell.priority > best.priority then
      best = spell
    end
  end
  return best and best.name or nil
end

return M
