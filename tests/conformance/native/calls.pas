program ReaPascalCalls;

{$mode objfpc}
{$inline off}

procedure ReaPascalCall(Value: LongInt); cdecl; public name 'rea_pascal_call';
begin
  WriteLn('pascal ', Value);
end;

var
  Index: LongInt;
begin
  for Index := 0 to 2 do { REA_VERIFY_CALLER_LOOP }
    ReaPascalCall(Index); { REA_VERIFY_CALLER_CALL }
end.
