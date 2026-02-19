import { describe, it, expect } from "vitest";
import { parseSvd } from "../svd";

describe("parseSvd", () => {
  it("parses minimal SVD with device -> peripheral -> register -> fields", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
    <device>
      <name>TestDevice</name>
      <peripherals>
        <peripheral>
          <name>GPIOA</name>
          <baseAddress>0x40000000</baseAddress>
          <registers>
            <register>
              <name>ODR</name>
              <addressOffset>0x14</addressOffset>
              <size>32</size>
              <fields>
                <field>
                  <name>PIN0</name>
                  <bitOffset>0</bitOffset>
                  <bitWidth>1</bitWidth>
                </field>
                <field>
                  <name>PIN1</name>
                  <bitOffset>1</bitOffset>
                  <bitWidth>1</bitWidth>
                </field>
              </fields>
            </register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    expect(device.name).toBe("TestDevice");
    expect(device.peripherals.length).toBe(1);
    expect(device.peripherals[0].name).toBe("GPIOA");
    expect(device.peripherals[0].baseAddress).toBe(0x40000000);
    expect(device.peripherals[0].registers.length).toBe(1);

    const reg = device.peripherals[0].registers[0];
    expect(reg.name).toBe("ODR");
    expect(reg.address).toBe(0x40000014);
    expect(reg.sizeBits).toBe(32);
    expect(reg.fields.length).toBe(2);
    expect(reg.fields[0].name).toBe("PIN0");
    expect(reg.fields[0].lsb).toBe(0);
    expect(reg.fields[0].msb).toBe(0);
    expect(reg.fields[1].name).toBe("PIN1");
    expect(reg.fields[1].lsb).toBe(1);
    expect(reg.fields[1].msb).toBe(1);
  });

  it("parses LSB/MSB field format", () => {
    const xml = `<device>
      <name>D</name>
      <peripherals>
        <peripheral>
          <name>P</name>
          <baseAddress>0x0</baseAddress>
          <registers>
            <register>
              <name>R</name>
              <addressOffset>0x0</addressOffset>
              <size>32</size>
              <fields>
                <field>
                  <name>F</name>
                  <lsb>4</lsb>
                  <msb>7</msb>
                </field>
              </fields>
            </register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    const field = device.peripherals[0].registers[0].fields[0];
    expect(field.lsb).toBe(4);
    expect(field.msb).toBe(7);
  });

  it("parses bitRange [msb:lsb] format", () => {
    const xml = `<device>
      <name>D</name>
      <peripherals>
        <peripheral>
          <name>P</name>
          <baseAddress>0x0</baseAddress>
          <registers>
            <register>
              <name>R</name>
              <addressOffset>0x0</addressOffset>
              <size>32</size>
              <fields>
                <field>
                  <name>F</name>
                  <bitRange>[15:8]</bitRange>
                </field>
              </fields>
            </register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    const field = device.peripherals[0].registers[0].fields[0];
    expect(field.lsb).toBe(8);
    expect(field.msb).toBe(15);
  });

  it("expands numeric dimension range 0-3", () => {
    const xml = `<device>
      <name>D</name>
      <peripherals>
        <peripheral>
          <name>P</name>
          <baseAddress>0x0</baseAddress>
          <registers>
            <register>
              <name>CH%s_CTRL</name>
              <dim>4</dim>
              <dimIncrement>4</dimIncrement>
              <dimIndex>0-3</dimIndex>
              <addressOffset>0x100</addressOffset>
              <size>32</size>
            </register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    const regs = device.peripherals[0].registers;
    expect(regs.length).toBe(4);
    expect(regs[0].name).toBe("CH0_CTRL");
    expect(regs[1].name).toBe("CH1_CTRL");
    expect(regs[2].name).toBe("CH2_CTRL");
    expect(regs[3].name).toBe("CH3_CTRL");
    expect(regs[0].address).toBe(0x100);
    expect(regs[1].address).toBe(0x104);
    expect(regs[2].address).toBe(0x108);
    expect(regs[3].address).toBe(0x10c);
  });

  it("expands letter dimension range A-D", () => {
    const xml = `<device>
      <name>D</name>
      <peripherals>
        <peripheral>
          <name>P</name>
          <baseAddress>0x0</baseAddress>
          <registers>
            <register>
              <name>PORT%s</name>
              <dim>4</dim>
              <dimIncrement>0x10</dimIncrement>
              <dimIndex>A-D</dimIndex>
              <addressOffset>0x0</addressOffset>
              <size>32</size>
            </register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    const regs = device.peripherals[0].registers;
    expect(regs.length).toBe(4);
    expect(regs[0].name).toBe("PORTA");
    expect(regs[1].name).toBe("PORTB");
    expect(regs[2].name).toBe("PORTC");
    expect(regs[3].name).toBe("PORTD");
  });

  it("expands explicit dimension indices", () => {
    const xml = `<device>
      <name>D</name>
      <peripherals>
        <peripheral>
          <name>P</name>
          <baseAddress>0x0</baseAddress>
          <registers>
            <register>
              <name>DMA%s</name>
              <dim>2</dim>
              <dimIncrement>4</dimIncrement>
              <dimIndex>TX,RX</dimIndex>
              <addressOffset>0x0</addressOffset>
              <size>32</size>
            </register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    const regs = device.peripherals[0].registers;
    expect(regs.length).toBe(2);
    expect(regs[0].name).toBe("DMATX");
    expect(regs[1].name).toBe("DMARX");
  });

  it("parses clusters with nested registers", () => {
    const xml = `<device>
      <name>D</name>
      <peripherals>
        <peripheral>
          <name>TIMER</name>
          <baseAddress>0x40001000</baseAddress>
          <registers>
            <cluster>
              <name>CH0</name>
              <addressOffset>0x20</addressOffset>
              <register>
                <name>CR</name>
                <addressOffset>0x0</addressOffset>
                <size>32</size>
              </register>
              <register>
                <name>SR</name>
                <addressOffset>0x4</addressOffset>
                <size>32</size>
              </register>
            </cluster>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    const regs = device.peripherals[0].registers;
    expect(regs.length).toBe(2);
    expect(regs[0].name).toBe("CR");
    expect(regs[0].path).toBe("TIMER.CH0.CR");
    expect(regs[0].address).toBe(0x40001020);
    expect(regs[1].name).toBe("SR");
    expect(regs[1].address).toBe(0x40001024);
  });

  it("parses enumerated values on fields", () => {
    const xml = `<device>
      <name>D</name>
      <peripherals>
        <peripheral>
          <name>P</name>
          <baseAddress>0x0</baseAddress>
          <registers>
            <register>
              <name>CR</name>
              <addressOffset>0x0</addressOffset>
              <size>32</size>
              <fields>
                <field>
                  <name>MODE</name>
                  <bitOffset>0</bitOffset>
                  <bitWidth>2</bitWidth>
                  <enumeratedValues>
                    <enumeratedValue>
                      <name>OFF</name>
                      <value>0</value>
                      <description>Disabled</description>
                    </enumeratedValue>
                    <enumeratedValue>
                      <name>ON</name>
                      <value>1</value>
                      <description>Enabled</description>
                    </enumeratedValue>
                  </enumeratedValues>
                </field>
              </fields>
            </register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    const field = device.peripherals[0].registers[0].fields[0];
    expect(field.enums.length).toBe(2);
    expect(field.enums[0].name).toBe("OFF");
    expect(field.enums[0].value).toBe(0);
    expect(field.enums[0].description).toBe("Disabled");
    expect(field.enums[1].name).toBe("ON");
    expect(field.enums[1].value).toBe(1);
  });

  it("handles empty device (no peripherals)", () => {
    const xml = `<device><name>Empty</name></device>`;
    const device = parseSvd(xml);
    expect(device.name).toBe("Empty");
    expect(device.peripherals.length).toBe(0);
  });

  it("handles missing optional fields (no resetValue, no fields)", () => {
    const xml = `<device>
      <name>D</name>
      <peripherals>
        <peripheral>
          <name>P</name>
          <baseAddress>0x0</baseAddress>
          <registers>
            <register>
              <name>SR</name>
              <addressOffset>0x0</addressOffset>
              <size>16</size>
            </register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const device = parseSvd(xml);
    const reg = device.peripherals[0].registers[0];
    expect(reg.name).toBe("SR");
    expect(reg.sizeBits).toBe(16);
    expect(reg.resetValue).toBeUndefined();
    expect(reg.fields.length).toBe(0);
  });
});
