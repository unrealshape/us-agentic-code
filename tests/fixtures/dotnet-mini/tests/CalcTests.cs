using Mini;
using Xunit;

public class CalcTests
{
    [Fact]
    public void AddWorks() => Assert.Equal(5, Calc.Add(2, 3));
}
