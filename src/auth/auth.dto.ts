import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MinLength, ValidateIf } from 'class-validator';

/** Log in with a Bangladeshi mobile number OR an email address (one of the two). */
export class RequestOtpDto {
  @ApiPropertyOptional({ example: '01712345678' })
  @ValidateIf((o: RequestOtpDto) => !o.email)
  @IsString()
  @Matches(/^(\+?880|0)1[3-9]\d{8}$/, { message: 'Enter a valid Bangladeshi mobile number' })
  phone?: string;

  @ApiPropertyOptional({ example: 'patient@gmail.com', description: 'Code is emailed via the Gmail account set in admin settings' })
  @ValidateIf((o: RequestOtpDto) => !o.phone)
  @IsEmail({}, { message: 'Enter a valid email address' })
  email?: string;
}

export class VerifyOtpDto extends RequestOtpDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  code: string;
}

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@demo.local' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Admin@12345' })
  @IsString()
  @MinLength(8)
  password: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @MinLength(20)
  refreshToken: string;
}
