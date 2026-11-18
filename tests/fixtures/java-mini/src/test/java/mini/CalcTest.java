package mini;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalcTest {
    @Test
    void addWorks() {
        assertEquals(5, Calc.add(2, 3));
    }
}
